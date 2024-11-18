import OpenAI from "openai";
import { Context } from "../../../types";
import { SuperOpenAi } from "./openai";
import { CompletionsModelHelper, ModelApplications } from "../../../types/llm";
import { encode } from "gpt-tokenizer";
import { logger } from "../../../helpers/errors";

export interface CompletionsType {
  answer: string;
  groundTruths: string[];
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
}

export class Completions extends SuperOpenAi {
  protected context: Context;

  constructor(client: OpenAI, context: Context) {
    super(client, context);
    this.context = context;
  }

  getModelMaxTokenLimit(model: string): number {
    // could be made more robust, unfortunately, there's no endpoint to get the model token limit
    const tokenLimits = new Map<string, number>([
      ["o1-mini", 128_000],
      ["o1-preview", 128_000],
      ["gpt-4-turbo", 128_000],
      ["gpt-4o", 128_000],
      ["gpt-4o-mini", 128_000],
      ["gpt-4", 8_192],
      ["gpt-3.5-turbo-0125", 16_385],
      ["gpt-3.5-turbo", 16_385],
    ]);

    return tokenLimits.get(model) || 128_000;
  }

  getModelMaxOutputLimit(model: string): number {
    // could be made more robust, unfortunately, there's no endpoint to get the model token limit
    const tokenLimits = new Map<string, number>([
      ["o1-mini", 65_536],
      ["o1-preview", 32_768],
      ["gpt-4-turbo", 4_096],
      ["gpt-4o-mini", 16_384],
      ["gpt-4o", 16_384],
      ["gpt-4", 8_192],
      ["gpt-3.5-turbo-0125", 4_096],
      ["gpt-3.5-turbo", 4_096],
    ]);

    return tokenLimits.get(model) || 16_384;
  }

  async getModelTokenLimit(): Promise<number> {
    return this.getModelMaxTokenLimit("o1-mini");
  }

  async createCompletion(
    query: string,
    model: string = "o1-mini",
    additionalContext: string[],
    localContext: string[],
    groundTruths: string[],
    botName: string,
    maxTokens: number
  ): Promise<CompletionsType> {
    const numTokens = await this.findTokenLength(query, additionalContext, localContext, groundTruths);
    logger.info(`Number of tokens: ${numTokens}`);

    const sysMsg = [
      "You Must obey the following ground truths: ",
      JSON.stringify(groundTruths) + "\n",
      "You are tasked with assisting as a GitHub bot by generating responses based on provided chat history and similar responses, focusing on using available knowledge within the provided corpus, which may contain code, documentation, or incomplete information. Your role is to interpret and use this knowledge effectively to answer user questions.\n\n# Steps\n\n1. **Understand Context**: Review the chat history and any similar provided responses to understand the context.\n2. **Extract Relevant Information**: Identify key pieces of information, even if they are incomplete, from the available corpus.\n3. **Apply Knowledge**: Use the extracted information and relevant documentation to construct an informed response.\n4. **Draft Response**: Compile the gathered insights into a coherent and concise response, ensuring it's clear and directly addresses the user's query.\n5. **Review and Refine**: Check for accuracy and completeness, filling any gaps with logical assumptions where necessary.\n\n# Output Format\n\n- Concise and coherent responses in paragraphs that directly address the user's question.\n- Incorporate inline code snippets or references from the documentation if relevant.\n\n# Examples\n\n**Example 1**\n\n*Input:*\n- Chat History: \"What was the original reason for moving the LP tokens?\"\n- Corpus Excerpts: \"It isn't clear to me if we redid the staking yet and if we should migrate. If so, perhaps we should make a new issue instead. We should investigate whether the missing LP tokens issue from the MasterChefV2.1 contract is critical to the decision of migrating or not.\"\n\n*Output:*\n\"It was due to missing LP tokens issue from the MasterChefV2.1 Contract.\n\n# Notes\n\n- Ensure the response is crafted from the corpus provided, without introducing information outside of what's available or relevant to the query.\n- Consider edge cases where the corpus might lack explicit answers, and justify responses with logical reasoning based on the existing information.",
      `Your name is: ${botName}`,
      "\n",
      "Main Context (Provide additional precedence in terms of information): ",
      localContext.join("\n"),
      "Secondary Context: ",
      additionalContext.join("\n"),
    ].join("\n");

    logger.info(`System message: ${sysMsg}`);
    logger.info(`Query: ${query}`);

    const res: OpenAI.Chat.Completions.ChatCompletion = await this.client.chat.completions.create({
      model: model,
      messages: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: sysMsg,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: query,
            },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      top_p: 0.5,
      frequency_penalty: 0,
      presence_penalty: 0,
      response_format: {
        type: "text",
      },
    });

    if (!res.choices || !res.choices[0].message) {
      logger.error(`Failed to generate completion: ${JSON.stringify(res)}`);
      return { answer: "", tokenUsage: { input: 0, output: 0, total: 0 }, groundTruths };
    }

    const answer = res.choices[0].message;
    if (answer && answer.content && res.usage) {
      return {
        answer: answer.content,
        groundTruths,
        tokenUsage: { input: res.usage.prompt_tokens, output: res.usage.completion_tokens, total: res.usage.total_tokens },
      };
    }
    return { answer: "", tokenUsage: { input: 0, output: 0, total: 0 }, groundTruths };
  }

  async createGroundTruthCompletion<TApp extends ModelApplications>(
    context: Context,
    groundTruthSource: string,
    systemMsg: string,
    model: CompletionsModelHelper<TApp>
  ): Promise<string | null> {
    const {
      env: { OPENAI_API_KEY },
      config: { openAiBaseUrl },
    } = context;

    const openAi = new OpenAI({
      apiKey: OPENAI_API_KEY,
      ...(openAiBaseUrl && { baseURL: openAiBaseUrl }),
    });

    const msgs = [
      {
        role: "system",
        content: systemMsg,
      },
      {
        role: "user",
        content: groundTruthSource,
      },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[];

    const res = await openAi.chat.completions.create({
      messages: msgs,
      model: model,
    });

    if (!res.choices || !res.choices[0].message || !res.choices[0].message.content) {
      this.context.logger.error(`Failed to generate ground truth completion: ${JSON.stringify(res)}`);
      return null;
    }

    return res.choices[0].message.content;
  }

  async findTokenLength(prompt: string, additionalContext: string[] = [], localContext: string[] = [], groundTruths: string[] = []): Promise<number> {
    // disallowedSpecial: new Set() because we pass the entire diff as the prompt we should account for all special characters
    return encode(prompt + additionalContext.join("\n") + localContext.join("\n") + groundTruths.join("\n"), { disallowedSpecial: new Set() }).length;
  }
}
