import { z } from "zod";
import { ProviderInvalidOutputError } from "@career-agent/domain";
import { assertNoSecrets } from "./prompt-guard.js";
import type {
  AIProvider,
  PromptMessage,
  ProviderRequest,
  ProviderRunMeta,
  TaskType,
} from "./types.js";
import type { RunLimits } from "@career-agent/domain";

export interface StructuredCall<T extends z.ZodType> {
  provider: AIProvider;
  taskType: TaskType;
  prompt: { id: string; version: string };
  messages: PromptMessage[];
  schema: T;
  limits: RunLimits;
  signal: AbortSignal;
  traceId: string;
  secretValues?: readonly string[];
}

export interface StructuredResult<T> {
  value: T;
  runs: ProviderRunMeta[];
  repaired: boolean;
}

/**
 * Calls a provider and validates its output with Zod. Invalid output gets exactly one repair attempt that
 * includes the validation errors; a second failure raises ProviderInvalidOutputError (fail closed).
 */
export async function runStructured<T extends z.ZodType>(
  call: StructuredCall<T>,
): Promise<StructuredResult<z.infer<T>>> {
  assertNoSecrets(call.messages, call.secretValues);
  const base: Omit<ProviderRequest, "messages"> = {
    taskType: call.taskType,
    promptId: call.prompt.id,
    promptVersion: call.prompt.version,
    outputJsonSchema: z.toJSONSchema(call.schema, { io: "input" }),
    limits: call.limits,
    signal: call.signal,
    traceId: call.traceId,
  };

  const first = await call.provider.run({ ...base, messages: call.messages });
  const parsed = call.schema.safeParse(first.output);
  if (parsed.success) return { value: parsed.data, runs: [first.meta], repaired: false };

  const issues = parsed.error.issues
    .slice(0, 20)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  const repairMessages: PromptMessage[] = [
    ...call.messages,
    {
      role: "user",
      content: `Your previous output did not match the required JSON schema. Validation errors:\n${issues.join("\n")}\nReturn only corrected JSON that matches the schema. Do not add information that is not in the provided content.`,
    },
  ];
  const second = await call.provider.run({ ...base, messages: repairMessages });
  const reparsed = call.schema.safeParse(second.output);
  if (reparsed.success)
    return { value: reparsed.data, runs: [first.meta, second.meta], repaired: true };
  throw new ProviderInvalidOutputError(
    call.provider.name,
    "Model output failed validation after one repair attempt.",
  );
}
