/**
 * Shared by photo classification and outfit suggestions.
 * Standard prices in USD per 1 million tokens, verified 2026-10-15:
 * https://developers.openai.com/api/docs/models/gpt-6-luna
 * service_tier "default" selects Standard processing:
 * https://developers.openai.com/api/reference/typescript/resources/responses
 * Recheck official prices and billing when changing this configuration.
 */
export const aiConfig = {
  model: "gpt-6-luna",
  inputUsdPerMillion: 0.1,
  outputUsdPerMillion: 0.5,
  serviceTier: "default",
  reasoningEffort: "none",
  maxOutputTokens: 700,
} as const;
