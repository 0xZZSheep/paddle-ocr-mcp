import express, { Request, Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import path from "node:path";
import * as os from "node:os";
import fs from "fs/promises";

const app = express();
app.use(express.json());

// 定义 Transport 映射的类型
interface TransportMap {
    [sessionId: string]: StreamableHTTPServerTransport;
}

// Map to store transports by session ID
const transports: TransportMap = {};

// 定义错误响应的类型
interface JSONRPCError {
    jsonrpc: '2.0';
    error: {
        code: number;
        message: string;
    };
    id: null;
}


interface PaddleOCRInput {
    fileUrl:string
}

interface LayoutParsingResult{
    markdown:{
        text:string;
        images: Record<string, string>;
    }
}


export async function downloadToBase64(
    url: string
): Promise<{ base64: string; fileName: string; fileType: 0 | 1 }> {
    // 使用 URL hash 作为缓存文件名
    const hash = createHash("sha256").update(url).digest("hex");
    const cacheDir = path.join(os.tmpdir(), "paddle-ocr-download-cache");

    // 确保缓存目录存在
    await fs.mkdir(cacheDir, { recursive: true });

    // 尝试从缓存读取
    const cachedFiles = await fs.readdir(cacheDir);
    const cachedFile = cachedFiles.find(f => f.startsWith(hash));
    if (cachedFile) {
        const buffer = await fs.readFile(path.join(cacheDir, cachedFile));
        const ext = path.extname(cachedFile).toLowerCase();
        const fileType: 0 | 1 = ext === ".pdf" ? 0 : 1;
        return { base64: buffer.toString("base64"), fileName: cachedFile, fileType };
    }

    // 缓存不存在，执行下载
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to download file: ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 根据 Content-Type 判断类型
    const contentType = res.headers.get("content-type")?.toLowerCase() || "";
    let fileType: 0 | 1;
    let ext: string;

    if (contentType.includes("pdf")) {
        fileType = 0;
        ext = "pdf";
    } else if (contentType.startsWith("image/")) {
        fileType = 1;
        // 尝试从 MIME 类型获取扩展名
        ext = contentType.split("/")[1]; // image/png → png
        if (ext === "jpeg") ext = "jpg"; // 常用处理
    } else {
        fileType = 1;
        ext = "bin";
    }

    const fileName = `${hash}.${ext}`;
    const cachePath = path.join(cacheDir, fileName);

    // 写入缓存
    await fs.writeFile(cachePath, buffer);

    return {
        base64: buffer.toString("base64"),
        fileName,
        fileType
    };
}


function replaceImagesInText(text:string, images:Record<string, string>):string {
    let result = text;

    for (const [key, url] of Object.entries(images)) {
        // 转义 key 中可能影响正则的字符
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedKey, 'g');

        result = result.replace(regex, url);
    }

    return result;
}

// Handle POST requests for client-to-server communication
app.post('/mcp', async (req: Request, res: Response): Promise<void> => {
    // Check for existing session ID
    const sessionId: string | undefined = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body as JSONRPCMessage)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: (): string => randomUUID(),
            onsessioninitialized: (newSessionId: string): void => {
                // Store the transport by session ID
                transports[newSessionId] = transport;
            }
            // DNS rebinding protection is disabled by default for backwards compatibility. If you are running this server
            // locally, make sure to set:
            // enableDnsRebindingProtection: true,
            // allowedHosts: ['127.0.0.1'],
        });

        // Clean up transport when closed
        transport.onclose = (): void => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
            }
        };
        const apiUrl = req.headers['x-api-url'] as string;
        const token = req.headers['x-token'] as string;
        const server: McpServer = new McpServer({
            name: 'example-server',
            version: '1.0.0'
        });

        server.registerTool(
            "paddle-ocr",
            {
                title: "Paddle OCR Layout Parsing",
                description:
                    "Call Paddle OCR layout parsing API. Supports file URL.",
                inputSchema: z.object({
                    fileUrl: z
                        .string()
                        .describe("HTTP direct link to PDF or image"),
                }),
            },
            async (args: PaddleOCRInput) => {
                const {fileUrl} = args
                const downloaded = await downloadToBase64(fileUrl);
                const {base64, fileType} = downloaded

                const payload = {
                    file: base64,
                    fileType,
                    markdownIgnoreLabels: [
                        "header",
                        "header_image",
                        "footer",
                        "footer_image",
                        "number",
                        "footnote",
                        "aside_text",
                    ],
                    useDocOrientationClassify: false,
                    useDocUnwarping: false,
                    useLayoutDetection: true,
                    useChartRecognition: false,
                    promptLabel: "ocr",
                    repetitionPenalty: 1,
                    temperature: 0,
                    topP: 1,
                    minPixels: 147384,
                    maxPixels: 2822400,
                    layoutNms: true,
                };
                const response = await fetch(apiUrl, {
                    method: "POST",
                    headers: {
                        Authorization: `token ${token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(payload),
                });
                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(
                        `Paddle OCR API error: ${response.status} - ${text}`
                    );
                }
                const result = (await response.json())['result']['layoutParsingResults'] as LayoutParsingResult[]

                return {
                    content: result.map(res=>{
                        const {text, images} = res.markdown
                        return {
                            type:'text',
                            text: replaceImagesInText(text, images)
                        }
                    }),
                };
            }
        )



        // ... set up server resources, tools, and prompts ...

        // Connect to the MCP server
        await server.connect(transport);
    } else {
        // Invalid request
        const errorResponse: JSONRPCError = {
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided'
            },
            id: null
        };
        res.status(400).json(errorResponse);
        return;
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body as JSONRPCMessage);
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId: string | undefined = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    const transport: StreamableHTTPServerTransport = transports[sessionId];
    await transport.handleRequest(req, res);
};

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', handleSessionRequest);

// Handle DELETE requests for session termination
app.delete('/mcp', handleSessionRequest);

const PORT: number = 3000;

app.listen(PORT, '0.0.0.0',(): void => {
    console.log(`MCP server listening on port ${PORT}`);
});