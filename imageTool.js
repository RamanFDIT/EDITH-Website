import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import './envConfig.js';

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// --- NANO BANANA (Gemini 2.5 Flash Image Generation) ---
export async function generateImage(args) {
    const { prompt, aspectRatio } = args;
    console.log(`🎨 Generating image (Nano Banana): "${prompt.substring(0, 50)}..."`);

    if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY not found.");

    try {
        const config = {};
        if (aspectRatio) {
            config.imageConfig = { aspectRatio };
        }

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-image",
            contents: prompt,
            config: {
                responseModalities: ['Text', 'Image'],
                ...config,
            },
        });

        // Save to temp/
        const tempDir = path.join(process.cwd(), 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const filename = `image-${Date.now()}.png`;
        const filePath = path.join(tempDir, filename);
        let captionText = "";

        for (const part of response.candidates[0].content.parts) {
            if (part.text) {
                captionText += part.text;
            } else if (part.inlineData) {
                const buffer = Buffer.from(part.inlineData.data, "base64");
                fs.writeFileSync(filePath, buffer);
                console.log(`🎨 Image saved: ${filePath}`);
            }
        }

        return JSON.stringify({
            success: true,
            localUrl: `/temp/${filename}`,
            caption: captionText || null,
            message: `Image generated and saved. Display it with: [IMAGE:/temp/${filename}]`,
        });
    } catch (error) {
        console.error("Image generation error:", error);
        return `Error generating image: ${error.message}`;
    }
}
