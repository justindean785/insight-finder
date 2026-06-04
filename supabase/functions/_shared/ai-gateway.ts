import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@1";

export function createLovableAiGatewayProvider(apiKey: string) {
  const provider = createOpenAICompatible({
    name: "lovable-ai-gateway",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    headers: { "Lovable-API-Key": apiKey },
  });
  return (modelId: string) => provider.chatModel(modelId);
}
