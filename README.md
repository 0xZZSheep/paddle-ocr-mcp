# paddle-vl-mcp

这是一个基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 协议开发的 Paddle OCR 服务端。

## 快速开始

### 1. 安装依赖
```bash
npm install
```
### 2. 构建项目
使用 esbuild 将 TypeScript 源码编译为生产环境代码：
```bash
npm run build
```
### 3. 运行服务
* **开发模式**((直接运行 TS))：npm run serve
* **生产模式**(运行编译后的 JS)：npm run start

## 使用 MCP Inspector 调试
MCP Inspector 是一个强大的开发者工具，可以在不接入客户端的情况下，通过浏览器界面直接测试你的 OCR 工具。

### Windows (PowerShell)
```
$env:DANGEROUSLY_OMIT_AUTH="true"; npx @modelcontextprotocol/inspector
npm run serve
```
### Windows (CMD)
```
set DANGEROUSLY_OMIT_AUTH=true && npx @modelcontextprotocol/inspector
npm run serve
```
### macOS / Linux (Bash/Zsh)
```
DANGEROUSLY_OMIT_AUTH=true npx @modelcontextprotocol/inspector
npm run serve
```