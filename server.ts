import express from "express";

import * as dotenv from "dotenv";
import admin from "firebase-admin";
import * as openaiPackage from "openai";

import cors, { CorsOptions } from "cors";

const { Configuration } = openaiPackage;

import * as https from "https";

import fetch, { RequestInfo } from "node-fetch";

import fs from "fs";
import { v4 as uuidv4 } from "uuid";

const serviceAccountPath = "/etc/secrets/FIREBASE_SERVICE_ACCOUNT";
const serviceAccountContent = fs.readFileSync(serviceAccountPath, "utf-8");
const serviceAccount = JSON.parse(serviceAccountContent);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

dotenv.config();

const app = express();

//// * PROVIDERS SETUP
// ? OPENAI SETUP
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new openaiPackage.OpenAIApi(configuration);

// ? STABILITY SETUP
const stabilityEngineId = "stable-diffusion-v1-5";
const stabilityApiHost = process.env.API_HOST ?? "https://api.stability.ai";
const stabilityApiKey = process.env.STABILITY_API_KEY;
//// ?*

const allowedOrigins = ["https://chat-cbd.vercel.app"];

const corsOptions: CorsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    if (origin && allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"), false);
    }
  },
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

app.use(express.json());

async function uploadImageToFirebase(imageInput: string | Buffer) {
  try {
    let buffer: Buffer;
    let contentType: string | null;
    const uniqueId = uuidv4();
    let fileExtension: string;

    if (
      typeof imageInput === "string" &&
      (imageInput.startsWith("http://") || imageInput.startsWith("https://"))
    ) {
      // Image input is a URL
      const response = await fetch(imageInput);
      buffer = await response.buffer();
      contentType = response.headers.get("content-type") || "image/png";
      fileExtension = imageInput.split(".").pop()?.split("?")[0] || "png";
    } else {
      // Image input is a base64 string
      const base64Data = imageInput
        .toString()
        .replace(/^data:image\/\w+;base64,/, "");
      buffer = Buffer.from(base64Data, "base64");
      const match = base64Data.match(/data:image\/(.*);base64/i);
      fileExtension = match ? match[1] : "png"; // default to png if we can't determine the file type
      contentType = `image/${fileExtension}`;
    }

    const filename = `${uniqueId}.${fileExtension}`;

    const file = admin.storage().bucket().file(filename);
    const writeStream = file.createWriteStream({
      metadata: {
        contentType: contentType,
      },
    });

    const uploadPromise = new Promise((resolve, reject) => {
      writeStream.on("error", (error: any) => reject(error));
      writeStream.on("finish", () => {
        file.getSignedUrl(
          {
            action: "read",
            expires: "03-17-2025",
          },
          (error: any, url: unknown) => {
            if (error) {
              reject(error);
            } else {
              resolve(url);
            }
          }
        );
      });
    });

    writeStream.end(buffer);

    const uploadedImageUrl = await uploadPromise.catch((error) => {
      console.error("Error uploading image:", error);
      throw error;
    });

    if (uploadedImageUrl === undefined) {
      console.error("uploadedImageUrl is undefined");
    } else {
      console.log("uploadedImageUrl:", uploadedImageUrl);
    }

    return uploadedImageUrl;
  } catch (error) {
    console.error("Error uploading image:", error);
    throw error;
  }
}

const PORT = process.env.PORT || 5000;

function preprocessChatHistory(messages: any[]) {
  return messages.map((message: { type: string; role: any; content: any }) => {
    // Check if the message is an image
    const isImage = message.type === "image";

    // Only return the role and content properties of each message
    return {
      role: message.role,
      content: isImage ? "generated image" : message.content,
    };
  });
}

app.post("/send-message", async (req, res) => {
  console.log("body received", req.body);
  try {
    const {
      userPrompt,
      type,
      selectedImageSize,
      selectedImageProvider,
      activeConversation,
      userId,
    } = req.body;
    console.log("body received", req.body);

    let conversation = null;

    if (activeConversation) {
      conversation = await getConversationFromDatabase(
        activeConversation,
        userId
      );
    }

    // Generate a unique ID
    function generateUniqueId() {
      const timestamp = Date.now();
      const randomNumber = Math.random();
      const hexadecimalString = randomNumber.toString(16);
      return `id-${timestamp}-${hexadecimalString}`;
    }

    // Create a new conversation if it doesn't exist
    if (!conversation || conversation.id === "null") {
      const newId = generateUniqueId();
      conversation = {
        id: newId,
        messages: [],
      };
      await saveConversationToFirebase(conversation, userId);
    }
    // Add the userPrompt to the conversation's messages array
    const updatedMessages = [...conversation.messages, userPrompt];

    // Preprocess the messages
    const preprocessedMessages = preprocessChatHistory(updatedMessages);

    /* console.log("🚀 ~ app.post ~ preprocessedMessages:", preprocessedMessages); */
    let newMessage;

    // ! image type
    if (type === "image") {
      // ?? OPENAI PROVIDER
      if (selectedImageProvider === "DALL-E") {
        const imageResponse = await openai.createImage({
          prompt: userPrompt.content,
          n: 1,
          size: selectedImageSize,
          response_format: "url",
        });

        const imageUrl = imageResponse.data.data[0].url;
        const uploadedImageUrl = await uploadImageToFirebase(
          imageUrl as string
        );

        newMessage = {
          role: "system",
          content: "",
          images: [uploadedImageUrl],
          type: "image",
        };

        console.log("request:", imageResponse);
        console.log("image size rec:", selectedImageSize);

        res.status(200).send({
          bot: "",
          type: "image",
          images: [uploadedImageUrl],
        });
      } else {
        // ?? STABLE DIF PROVIDER{
        const engineId = "stable-diffusion-v1-5";

        const [width, height] = selectedImageSize.split("x").map(Number);

        const imageResponse = await fetch(
          `${stabilityApiHost}/v1/generation/${stabilityEngineId}/text-to-image`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Authorization: `Bearer ${stabilityApiKey}`,
            },
            body: JSON.stringify({
              text_prompts: [
                {
                  text: userPrompt.content,
                  weight: 0.5,
                },
              ],
              cfg_scale: 7,
              clip_guidance_preset: "FAST_BLUE",
              height: height,
              width: width,
              samples: 1,
              steps: 30,
            }),
          }
        );

        if (!imageResponse.ok) {
          throw new Error(`Non-200 response: ${await imageResponse.text()}`);
        }

        interface GenerationResponse {
          artifacts: Array<{
            base64: string;
            seed: number;
            finishReason: string;
          }>;
        }

        const responseJSON = (await imageResponse.json()) as GenerationResponse;
        console.log("🚀 ~ file: server.ts:283 ~ responseJSON:", responseJSON);

        const uploadedImageUrls: string[] = [];

        for (const [index, image] of responseJSON.artifacts.entries()) {
          const imageBuffer = Buffer.from(image.base64, "base64");
          const imageName = `v1_txt2img_${index}.png`;
          const uploadedImageUrl = await uploadImageToFirebase(image.base64);

          uploadedImageUrls.push(uploadedImageUrl as string);
          console.log("Buffer length:", imageBuffer.length);
          console.log("base64 string length:", image.base64.length);
          console.log("Firebase image URL:", uploadedImageUrl);
        }

        newMessage = {
          role: "system",
          content: "",
          images: uploadedImageUrls,
          type: "image",
        };

        console.log("uploadedImageUrls:", uploadedImageUrls);

        console.log("request:", imageResponse);
        console.log("image size rec:", selectedImageSize);

        res.status(200).send({
          bot: "",
          type: "image",
          images: uploadedImageUrls,
        });
      }
    }
    // ! text type
    else {
      const response = await openai.createChatCompletion({
        model: "gpt-4",
        messages: preprocessedMessages,
        temperature: 0.5,
        max_tokens: 2000,
        top_p: 1,
        frequency_penalty: 0.5,
        presence_penalty: 0,
      });

      console.log("OpenAI API response:", response);

      const botResponse = response.data.choices[0].message?.content.trim();

      newMessage = {
        role: "system",
        content: botResponse,
        type: "text",
      };

      res.status(200).send({
        bot: botResponse,
        type: "text",
      });
    }

    // Update the messages array with the new message

    const updatedMessagesWithResponse = [...updatedMessages, newMessage];

    await saveConversationToFirebase(
      { id: activeConversation, messages: updatedMessagesWithResponse },
      userId
    );
  } catch (error: any) {
    const { response } = error;
    console.log("🚀 ~ app.post ~ error:", error);
    let errorMessage = "An unknown error occurred";
    let statusCode = 500; // Add this line to send the correct status code

    if (response && response.data && response.data.error) {
      errorMessage = response.data.error.message;
      statusCode = response.status || 500; // Update the status code if available
    }
    res.status(statusCode).send({ error: errorMessage });
    console.log("🚀 ~ app.post ~ errorMessage:", errorMessage);
    // Send the status code along with the error message
  }
});

/* app.use((error, req, res, next) => {
  console.error(error);
  const { response } = error;
  let errorMessage = "An unknown error occurred";

  if (response && response.data && response.data.error) {
    errorMessage = response.data.error.message;
  }

  res.status(500).send({
    error: errorMessage,
    statusCode: response.status,
    statusText: response.statusText,
  });
}); */

async function getConversationFromDatabase(
  activeConversation: any,
  userId: any
) {
  try {
    const db = admin.firestore();
    const conversationsRef = db.collection(`users/${userId}/conversations`);
    const docRef = conversationsRef.doc(activeConversation);

    const doc = await docRef.get();

    if (doc.exists) {
      return doc.data();
    } else {
      return null;
    }
  } catch (error) {
    console.error("Error getting conversation from Firebase:", error);
    throw error;
  }
}

async function saveConversationToFirebase(
  conversation: { id: any; messages?: any[] | never[] },
  userId: any
) {
  /* console.log("Saving conversation:", conversation); */
  try {
    const db = admin.firestore();
    const conversationsRef = db.collection(`users/${userId}/conversations`);
    const docRef = conversationsRef.doc(conversation.id);

    /* console.log("Before saving to Firebase:", conversation); */
    await docRef.set(conversation);
    /* console.log("After saving to Firebase:", conversation); */

    /* console.log(`Conversation ${conversation.id} saved to Firebase.`); */
  } catch (error) {
    console.error("Error saving conversation to Firebase:", error);
  }
}

app.listen(process.env.PORT || 5000, () =>
  console.log(
    `Server is running on port http://localhost:${process.env.PORT || 5000}`
  )
);

app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

const options = {
  hostname: "chat-cbd.onrender.com",
  path: "/ping",
  method: "GET",
};

// Self-ping function
function selfPing() {
  console.log("Pinging to keep the server awake...");
  https
    .request(options, (res) => {
      console.log(`Self-ping status: ${res.statusCode}`);
      res.on("data", (d) => {
        process.stdout.write(d);
      });
    })
    .on("error", (err) => {
      console.error(`Self-ping error: ${err.message}`);
    })
    .end();
}

// Schedule the self-ping every 14 minutes
setInterval(selfPing, 14 * 60 * 1000);
