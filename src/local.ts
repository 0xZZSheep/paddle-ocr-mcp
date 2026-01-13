import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import * as fs from "fs/promises";
import * as path from "path";
import * as z from 'zod';

import { fileTypeFromFile } from 'file-type';
import {server as paddleServer} from "./paddle";


interface ServerConfig {
    apiUrl?: string;
    token?: string;
}


function loadConfig(): ServerConfig {
    const config: ServerConfig = {
        apiUrl: process.env.PADDLEOCR_MCP_SERVER_URL,
        token: process.env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN,
    };
    return config;
}

function normalizePath(inputPath: string): string {
    if (typeof inputPath !== "string") {
        throw new Error("Path must be a string")
    }

    const trimmed = inputPath.trim()
    if (trimmed === "") {
        throw new Error("Path cannot be empty")
    }

    // 防止 null byte
    if (trimmed.includes("\0")) {
        throw new Error("Path contains null byte")
    }

    // 统一分隔符（避免 Windows / Unix 混用）
    const cleaned = trimmed.replace(/\\/g, "/")

    // Node.js 级别标准化
    const normalized = path.normalize(cleaned)

    // normalize 可能返回 "."
    if (normalized === "." || normalized === "") {
        throw new Error("Invalid path")
    }

    return normalized
}


const OCRArgsSchema = z.object({
    path: z.string()
})

class PaddleServer {
    private server: McpServer;
    private config: ServerConfig;

    constructor(config: ServerConfig) {
        this.config = config;

        this.server = new McpServer(
            {
                name: "paddle-ocr-mcp",
                version: "0.0.2",
            },
            {
                capabilities: {
                    resources: {},
                },
            }
        );

        this.setupTools()
    }

    private setupTools(){
        this.server.registerTool(
            "paddle-ocr",
            {
                title: "Paddle OCR Layout Parsing",
                description:
                    "Call Paddle OCR layout parsing API. Supports file URL.",
                inputSchema: z.object({
                    path: z
                        .string()
                        .describe("HTTP direct link to PDF or image"),
                }),
            },
            async (args: z.infer<typeof OCRArgsSchema>) => {
                try{
                    const filePath = normalizePath(args.path)
                    const type = await fileTypeFromFile(filePath);

                    if (!type) {
                        return {
                            content:[{
                                type:'text',
                                text:'无法识别文件类型'
                            }],
                            isError: true
                        }
                    }
                    const isPDF = type.ext === 'pdf' && type.mime === 'application/pdf';
                    const isImage = type.mime.startsWith('image/');
                    if(isPDF || isImage){
                        return paddleServer({
                            base64: await fs.readFile(filePath,{encoding:'base64'}),
                            fileType: isPDF ? 0 : 1,
                            apiUrl: this.config.apiUrl,
                            token: this.config.token
                        })
                    }
                    else{
                        return {
                            content:[{
                                type:'text',
                                text:'不支持的文件类型'
                            }],
                            isError: true
                        }
                    }
                } catch (e){
                    return {
                        content:[{
                            type:"text",
                            text: e.toString()
                        }],
                        isError: true
                    }
                }
            }
        )
    }

    async run(): Promise<void> {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);

    }
}

async function main() {
    const config = loadConfig();

    const server = new PaddleServer(config);
    await server.run();
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});