// Importamos las bibliotecas necesarias. El tipo de proyecto 'module' permite esta sintaxis.
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import fs from "node:fs";
import express from 'express'; // Importamos Express
import path from 'path'; // Importamos 'path' para manejar rutas de archivos
import { fileURLToPath } from 'url'; // Importamos para resolver el path del módulo
import WavEncoder from 'wav-encoder'; // Importamos la biblioteca para codificar audio

// Cargamos las variables de entorno desde el archivo .env
dotenv.config();

// Obtenemos la clave de API de Gemini
const API_KEY = process.env.API_KEY;

// Verificamos si la clave de API está presente
if (!API_KEY) {
  console.error("Error: API_KEY no está definida en el archivo .env.");
  console.error("Asegúrate de haber creado el archivo .env y de haber pegado tu clave de API allí.");
  process.exit(1);
}

// Inicializamos el modelo de Gemini para la generación de imágenes, texto y audio.
const genAI = new GoogleGenerativeAI(API_KEY);

// Creamos una referencia al directorio actual para poder servir archivos estáticos.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const imagesDir = path.join(publicDir, 'images');
const audioDir = path.join(publicDir, 'audio');

// Aseguramos que los directorios 'public', 'public/images' y 'public/audio' existan.
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir);
}
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir);
}
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir);
}

/**
 * Función que implementa un retraso exponencial para reintentos de la API.
 * @param {number} attempt - El número de intento actual.
 */
function sleep(attempt) {
    const delay = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 1000);
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Main function that generates a story and multiple images as a sequence.
 * @param {string} personaje - The main character.
 * @param {string} lugar - The story location.
 * @param {string} objeto - The key object.
 * @param {number} numImages - The number of images to generate for the sequence.
 */
async function crearCuentoEImagenesSecuencia(personaje, lugar, objeto, numImages = 3) {
    let cuento = null;
    let imageUrls = [];
    const maxAttempts = 5;

    console.log("Iniciando la generación de contenido con Gemini 2.0 Flash...");
    console.log("----------------------------------------");
    
    // The prompt for the story.
    const cuentoPrompt = `Crea un cuento corto y original de aproximadamente 200 palabras. La historia debe incluir a un ${personaje} en ${lugar} con un ${objeto}. El cuento debe tener un inicio, un desarrollo y un final.`;

    // 1. Generamos el cuento primero
    let cuentoResponse;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const result = await genAI.getGenerativeModel({ model: "gemini-1.5-flash" }).generateContent(cuentoPrompt);
            cuentoResponse = result.response;
            if (cuentoResponse && cuentoResponse.candidates && cuentoResponse.candidates.length > 0) {
                cuento = cuentoResponse.candidates[0].content.parts[0].text;
                break;
            } else {
                console.warn(`Intento ${i + 1} fallido para generar cuento. Reintentando...`);
                await sleep(i);
            }
        } catch (error) {
            console.warn(`Intento ${i + 1} fallido debido a un error: ${error.message}. Reintentando...`);
            await sleep(i);
        }
    }
    if (!cuento) {
        throw new Error("No se pudo generar el cuento después de varios intentos.");
    }
    console.log("--- Cuento Generado ---");
    console.log(cuento);
    console.log("----------------------------------------");

    // 2. Generamos prompts secuenciales para las imágenes
    const imagePrompts = await generarPromptsSecuenciales(cuento, numImages);

    // 3. Generamos las imágenes para cada prompt de la secuencia
    for (const [j, imagePrompt] of imagePrompts.entries()) {
        let imageResponse;
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const result = await genAI.getGenerativeModel({
                    model: "gemini-2.0-flash-preview-image-generation",
                }).generateContent({
                    contents: [{ parts: [{ text: imagePrompt }] }],
                    generationConfig: {
                        responseModalities: ['IMAGE', 'TEXT'],
                    },
                });

                imageResponse = result.response;
                if (imageResponse && imageResponse.candidates && imageResponse.candidates.length > 0) {
                    const imageData = imageResponse.candidates[0].content.parts.find(p => p.inlineData)?.inlineData.data;
                    if (imageData) {
                        const buffer = Buffer.from(imageData, "base64");
                        const fileName = `cuento_ilustrado_${Date.now()}_${j + 1}.png`;
                        const filePath = path.join(imagesDir, fileName);
                        fs.writeFileSync(filePath, buffer);
                        imageUrls.push(`/images/${fileName}`);
                        console.log(`--- Imagen Generada (Variación ${j + 1}) ---`);
                        console.log(`✅ Imagen guardada en: ${filePath}`);
                        break;
                    } else {
                        console.warn(`Intento ${i + 1} fallido: No se encontraron datos de imagen en la respuesta. Reintentando...`);
                        await sleep(i);
                    }
                } else {
                    console.warn(`Intento ${i + 1} fallido para generar imagen. Reintentando...`);
                    await sleep(i);
                }
            } catch (error) {
                console.warn(`Intento ${i + 1} fallido debido a un error: ${error.message}. Reintentando...`);
                await sleep(i);
            }
        }
    }

    if (imageUrls.length === 0) {
        throw new Error("No se pudo generar ninguna imagen después de varios intentos.");
    }

    return { cuento, imageUrls };
}

/**
 * Helper function to generate sequential image prompts based on the story.
 * @param {string} story - The generated story text.
 * @param {number} numPrompts - The number of prompts to generate.
 * @returns {Promise<string[]>} An array of sequential image prompts.
 */
async function generarPromptsSecuenciales(story, numPrompts) {
    let response;
    const maxAttempts = 5;
    const promptText = `
        Given the following story, identify ${numPrompts} key scenes that would make good illustrations.
        For each scene, provide a detailed, single-sentence image prompt.
        The response should be a JSON array of strings. Each string is a prompt.
        Story: "${story}"
    `;

    for (let i = 0; i < maxAttempts; i++) {
        try {
            const result = await genAI.getGenerativeModel({ model: "gemini-1.5-flash" }).generateContent(promptText);
            response = result.response;
            if (response && response.candidates && response.candidates.length > 0) {
                const jsonText = response.candidates[0].content.parts[0].text;
                try {
                    // Try to clean the text to find the JSON array
                    const cleanedText = jsonText.substring(jsonText.indexOf('[')).replace(/```json|```/g, '').trim();
                    const prompts = JSON.parse(cleanedText);
                    if (Array.isArray(prompts) && prompts.length > 0) {
                        return prompts.slice(0, numPrompts);
                    }
                } catch (jsonError) {
                    console.warn(`Intento ${i + 1} fallido al parsear JSON. Reintentando...`);
                }
            } else {
                console.warn(`Intento ${i + 1} fallido para generar prompts. Reintentando...`);
                await sleep(i);
            }
        } catch (error) {
            console.warn(`Intento ${i + 1} fallido debido a un error: ${error.message}. Reintentando...`);
            await sleep(i);
        }
    }
    
    // Fallback if no prompts could be generated.
    console.warn("No se pudieron generar prompts secuenciales. Usando un prompt genérico.");
    return [
        `Render 3D de alta calidad, que muestre la escena principal del cuento: ${story.substring(0, 50)}...`,
        `Render 3D de alta calidad, que muestre una escena de acción del cuento: ${story.substring(50, 100)}...`,
        `Render 3D de alta calidad, que muestre el final feliz del cuento: ${story.substring(100, 150)}...`
    ];
}

/**
 * Función que genera el audio de un cuento utilizando la API de TTS de Gemini.
 * @param {string} cuento - El texto del cuento a convertir en audio.
 * @returns {Promise<string>} La URL del archivo de audio generado.
 */
async function generarAudioDeCuento(cuento) {
    let response;
    const maxAttempts = 5;

    try {
        console.log("Iniciando la generación de audio con Gemini TTS...");
        console.log("----------------------------------------");

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const result = await genAI.getGenerativeModel({
                    model: "gemini-2.5-flash-preview-tts"
                }).generateContent({
                    contents: [{
                        parts: [{
                            text: cuento
                        }]
                    }],
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                // CAMBIO: Usamos la voz 'Orus' para un tono más de narrador.
                                prebuiltVoiceConfig: {
                                    voiceName: "Orus" 
                                }
                            }
                        }
                    }
                });

                response = result.response;
                if (response && response.candidates && response.candidates.length > 0) {
                    break; // Salir del bucle si la respuesta es exitosa
                } else {
                    console.warn(`Intento ${i + 1} fallido. Reintentando...`);
                    await sleep(i);
                }
            } catch (error) {
                console.warn(`Intento ${i + 1} fallido debido a un error: ${error.message}. Reintentando...`);
                await sleep(i);
            }
        }

        const candidates = response.candidates;
        if (!candidates || candidates.length === 0) {
            throw new Error("La respuesta de la API de audio no contiene candidatos después de varios intentos.");
        }

        const audioDataPart = candidates[0].content.parts.find(p => p.inlineData && p.inlineData.mimeType.startsWith('audio/'));
        if (!audioDataPart) {
            throw new Error("La respuesta de la API no contiene datos de audio.");
        }

        const audioData = audioDataPart.inlineData.data;
        const mimeType = audioDataPart.inlineData.mimeType;

        // API de TTS de Gemini retorna raw signed PCM 16 bit data.
        const sampleRate = parseInt(mimeType.match(/rate=(\d+)/)[1], 10);
        const pcmData = Buffer.from(audioData, 'base64');
        
        // CORRECCIÓN: Usamos `new Int16Array(pcmData.buffer)` para crear el array.
        // También necesitamos asegurarnos de que el buffer tiene la alineación correcta.
        const pcm16 = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);

        const wavData = {
            sampleRate: sampleRate,
            channelData: [new Float32Array(pcm16).map(sample => sample / 32768)] // Convertimos a Float32
        };

        const wavBuffer = await WavEncoder.encode(wavData);
        
        const fileName = `cuento_audio_${Date.now()}.wav`;
        const filePath = path.join(audioDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(wavBuffer));
        
        const audioUrl = `/audio/${fileName}`;
        console.log(`--- Audio Generado ---`);
        console.log(`✅ Audio guardado en: ${filePath}`);
        return audioUrl;

    } catch (error) {
        console.error("Error al generar el audio:", error);
        throw error;
    }
}

// --- Configuración del servidor web ---

const app = express();
const port = 3000;

// Servimos los archivos estáticos desde el directorio 'public'.
app.use(express.static(publicDir));

// Definimos la ruta para consumir el servicio que genera cuento e imagen
app.get('/create-story', async (req, res) => {
    const { personaje, lugar, objeto } = req.query;

    if (!personaje || !lugar || !objeto) {
        return res.status(400).json({ error: 'Faltan parámetros: personaje, lugar y objeto son obligatorios.' });
    }

    try {
        const { cuento, imageUrls } = await crearCuentoEImagenesSecuencia(personaje, lugar, objeto, 1);
        
        // Construimos la URL completa para la imagen
        const fullImageUrls = imageUrls.map(imageUrl => `${req.protocol}://${req.get('host')}${imageUrl}`);

        // Enviamos la respuesta como JSON con el cuento y la URL de la imagen completa.
        res.json({
            cuento: cuento,
            imageUrls: fullImageUrls
        });

    } catch (error) {
        res.status(500).json({ error: 'Hubo un error al generar el cuento y la imagen.' });
    }
});

// Definimos la nueva ruta para consumir el servicio que genera cuento y audio
app.get('/create-story-audio', async (req, res) => {
    const { personaje, lugar, objeto } = req.query;
    
    if (!personaje || !lugar || !objeto) {
        return res.status(400).json({ error: 'Faltan parámetros: personaje, lugar y objeto son obligatorios.' });
    }

    try {
        // Obtenemos el cuento y las URLs de las imágenes
        const { cuento, imageUrls } = await crearCuentoEImagenesSecuencia(personaje, lugar, objeto, 3);
        if (!cuento) {
            throw new Error("No se pudo generar el cuento para el audio.");
        }
        
        // Generamos el audio a partir del cuento
        const audioUrl = await generarAudioDeCuento(cuento);
        
        // Construimos las URLs completas
        const fullAudioUrl = `${req.protocol}://${req.get('host')}${audioUrl}`;
        const fullImageUrls = imageUrls.map(imageUrl => `${req.protocol}://${req.get('host')}${imageUrl}`);

        // Enviamos la respuesta con el cuento, las URLs de las imágenes y la URL del audio.
        res.json({
            cuento: cuento,
            imageUrls: fullImageUrls,
            audioUrl: fullAudioUrl
        });

    } catch (error) {
        res.status(500).json({ error: 'Hubo un error al generar el cuento, la imagen y el audio.' });
    }
});

// Iniciamos el servidor
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
    console.log(`Puedes probar el servicio de cuento e imagen en:`);
    console.log(`http://localhost:${port}/create-story?personaje=un pirata galactico&lugar=un asteroide abandonado&objeto=un mapa estelar holografico`);
    console.log(`Puedes probar el servicio de cuento, imagen y audio en:`);
    console.log(`http://localhost:${port}/create-story-audio?personaje=un pirata galactico&lugar=un asteroide abandonado&objeto=un mapa estelar holografico`);
});

