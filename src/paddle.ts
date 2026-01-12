import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
interface ServerParams{
    base64:string,
    fileType: 0|1,
    apiUrl: string,
    token: string
}

interface LayoutParsingResult{
    markdown:{
        text:string;
        images: Record<string, string>;
    }
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

export const server = async ({base64, fileType, apiUrl, token}:ServerParams):Promise<CallToolResult>=>{
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
        return {
            content:[{
                type:"text",
                text: `Paddle OCR API error: ${response.status} - ${text}`
            }],
            isError: true
        }
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