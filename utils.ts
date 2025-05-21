import { OpenAI } from "openai";

/**
 * Fetches the popular GitHub repositories from the specified URL
 */
export async function fetchPopularRepos(): Promise<string | null> {
  try {
    const response = await fetch("https://popular.forgithub.com/index.md");

    if (!response.ok) {
      throw new Error(`Failed to fetch with status: ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    console.error("Error fetching popular repos:", error);
    return null;
  }
}

/**
 * Process user preferences against repository data using OpenAI
 */
export async function processUserPreferences(
  reposData: string,
  preferences: string,
  apiKey: string,
): Promise<string | null> {
  try {
    if (!apiKey) {
      throw new Error("OpenAI API key is not configured");
    }

    const openai = new OpenAI({
      apiKey: apiKey,
    });

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are an assistant that helps developers find GitHub repositories that match their interests.",
        },
        {
          role: "user",
          content: `Based on my preferences: "${preferences}", please analyze the following list of trending GitHub repositories and return a list of the top 5-10 repositories that best match my interests. Focus on the most relevant repos, providing their name, description, and why they match my interests. Format the results in Markdown.

Here's the list of trending repositories:

${reposData.slice(0, 50000)}`,
        },
      ],
      temperature: 0.7,
      max_tokens: 1500,
    });

    return response.choices[0]?.message?.content || null;
  } catch (error) {
    console.error("Error processing preferences with OpenAI:", error);
    return null;
  }
}
