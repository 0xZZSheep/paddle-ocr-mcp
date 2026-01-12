import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import * as fs from "fs/promises";
import * as path from "path";
import * as z from 'zod';
import { minimatch } from "minimatch";
import { fileTypeFromFile } from 'file-type';
import {formatSize, getFileStats, validatePath} from "./lib";
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


interface FileResource {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
    path: string;
    size: number;
}

const ListDirectoryArgsSchema = z.object({
    path: z.string(),
});

const ListDirectoryWithSizesArgsSchema = z.object({
    path: z.string(),
    sortBy: z.enum(['name', 'size']).optional().default('name').describe('Sort entries by name or size'),
});

const DirectoryTreeArgsSchema = z.object({
    path: z.string(),
    excludePatterns: z.array(z.string()).optional().default([])
});

const GetFileInfoArgsSchema = z.object({
    path: z.string(),
});

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
            "list_directory",
            {
                title: "List Directory",
                description:
                    "Get a detailed listing of all files and directories in a specified path. " +
                    "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
                    "prefixes. This tool is essential for understanding directory structure and " +
                    "finding specific files within a directory. Only works within allowed directories.",
                inputSchema: {
                    path: z.string()
                },
                outputSchema: { content: z.string() },
                annotations: { readOnlyHint: true }
            },
            async (args: z.infer<typeof ListDirectoryArgsSchema>) => {
                const validPath = await validatePath(args.path);
                const entries = await fs.readdir(validPath, { withFileTypes: true });
                const formatted = entries
                    .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
                    .join("\n");
                return {
                    content: [{ type: "text" as const, text: formatted }],
                    structuredContent: { content: formatted }
                };
            }
        );
        this.server.registerTool(
            "list_directory_with_sizes",
            {
                title: "List Directory with Sizes",
                description:
                    "Get a detailed listing of all files and directories in a specified path, including sizes. " +
                    "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
                    "prefixes. This tool is useful for understanding directory structure and " +
                    "finding specific files within a directory. Only works within allowed directories.",
                inputSchema: {
                    path: z.string(),
                    sortBy: z.enum(["name", "size"]).optional().default("name").describe("Sort entries by name or size")
                },
                outputSchema: { content: z.string() },
                annotations: { readOnlyHint: true }
            },
            async (args: z.infer<typeof ListDirectoryWithSizesArgsSchema>) => {
                const validPath = await validatePath(args.path);
                const entries = await fs.readdir(validPath, { withFileTypes: true });

                // Get detailed information for each entry
                const detailedEntries = await Promise.all(
                    entries.map(async (entry) => {
                        const entryPath = path.join(validPath, entry.name);
                        try {
                            const stats = await fs.stat(entryPath);
                            return {
                                name: entry.name,
                                isDirectory: entry.isDirectory(),
                                size: stats.size,
                                mtime: stats.mtime
                            };
                        } catch (error) {
                            return {
                                name: entry.name,
                                isDirectory: entry.isDirectory(),
                                size: 0,
                                mtime: new Date(0)
                            };
                        }
                    })
                );

                // Sort entries based on sortBy parameter
                const sortedEntries = [...detailedEntries].sort((a, b) => {
                    if (args.sortBy === 'size') {
                        return b.size - a.size; // Descending by size
                    }
                    // Default sort by name
                    return a.name.localeCompare(b.name);
                });

                // Format the output
                const formattedEntries = sortedEntries.map(entry =>
                    `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.name.padEnd(30)} ${
                        entry.isDirectory ? "" : formatSize(entry.size).padStart(10)
                    }`
                );

                // Add summary
                const totalFiles = detailedEntries.filter(e => !e.isDirectory).length;
                const totalDirs = detailedEntries.filter(e => e.isDirectory).length;
                const totalSize = detailedEntries.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.size), 0);

                const summary = [
                    "",
                    `Total: ${totalFiles} files, ${totalDirs} directories`,
                    `Combined size: ${formatSize(totalSize)}`
                ];

                const text = [...formattedEntries, ...summary].join("\n");
                const contentBlock = { type: "text" as const, text };
                return {
                    content: [contentBlock],
                    structuredContent: { content: text }
                };
            }
        );
        this.server.registerTool(
            "directory_tree",
            {
                title: "Directory Tree",
                description:
                    "Get a recursive tree view of files and directories as a JSON structure. " +
                    "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
                    "Files have no children array, while directories always have a children array (which may be empty). " +
                    "The output is formatted with 2-space indentation for readability. Only works within allowed directories.",
                inputSchema: {
                    path: z.string(),
                    excludePatterns: z.array(z.string()).optional().default([])
                },
                outputSchema: { content: z.string() },
                annotations: { readOnlyHint: true }
            },
            async (args: z.infer<typeof DirectoryTreeArgsSchema>) => {
                interface TreeEntry {
                    name: string;
                    type: 'file' | 'directory';
                    children?: TreeEntry[];
                }
                const rootPath = args.path;

                async function buildTree(currentPath: string, excludePatterns: string[] = []): Promise<TreeEntry[]> {
                    const validPath = await validatePath(currentPath);
                    const entries = await fs.readdir(validPath, { withFileTypes: true });
                    const result: TreeEntry[] = [];

                    for (const entry of entries) {
                        const relativePath = path.relative(rootPath, path.join(currentPath, entry.name));
                        const shouldExclude = excludePatterns.some(pattern => {
                            if (pattern.includes('*')) {
                                return minimatch(relativePath, pattern, { dot: true });
                            }
                            // For files: match exact name or as part of path
                            // For directories: match as directory path
                            return minimatch(relativePath, pattern, { dot: true }) ||
                                minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
                                minimatch(relativePath, `**/${pattern}/**`, { dot: true });
                        });
                        if (shouldExclude)
                            continue;

                        const entryData: TreeEntry = {
                            name: entry.name,
                            type: entry.isDirectory() ? 'directory' : 'file'
                        };

                        if (entry.isDirectory()) {
                            const subPath = path.join(currentPath, entry.name);
                            entryData.children = await buildTree(subPath, excludePatterns);
                        }

                        result.push(entryData);
                    }

                    return result;
                }

                const treeData = await buildTree(rootPath, args.excludePatterns);
                const text = JSON.stringify(treeData, null, 2);
                const contentBlock = { type: "text" as const, text };
                return {
                    content: [contentBlock],
                    structuredContent: { content: text }
                };
            }
        );

        this.server.registerTool(
            "get_file_info",
            {
                title: "Get File Info",
                description:
                    "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
                    "information including size, creation time, last modified time, permissions, " +
                    "and type. This tool is perfect for understanding file characteristics " +
                    "without reading the actual content. Only works within allowed directories.",
                inputSchema: {
                    path: z.string()
                },
                outputSchema: { content: z.string() },
                annotations: { readOnlyHint: true }
            },
            async (args: z.infer<typeof GetFileInfoArgsSchema>) => {
                const validPath = await validatePath(args.path);
                const info = await getFileStats(validPath);
                const text = Object.entries(info)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join("\n");
                return {
                    content: [{ type: "text" as const, text }],
                    structuredContent: { content: text }
                };
            }
        );
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