import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

export async function POST(req: NextRequest) {
  try {
    const { query, platform, jobRole } = await req.json();

    const prompt = `You are a job search assistant. Extract structured search parameters from this query.

Platform: ${platform}
Job Role: ${jobRole}
User Query: "${query}"

Return ONLY a JSON object like this (no extra text, no markdown):
{
  "keywords": "main search keywords",
  "jobType": "Remote or Onsite or Any",
  "location": "Remote or city name",
  "experienceLevel": "entry or mid or senior or any"
}`;

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 200,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
      }
    );

    const content = response.data.choices[0].message.content;
    const cleaned = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return NextResponse.json({ success: true, data: parsed });
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error("Groq Error:", error.response?.data);
      return NextResponse.json(
        { success: false, error: JSON.stringify(error.response?.data) },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { success: false, error: "Unknown error" },
      { status: 500 }
    );
  }
}