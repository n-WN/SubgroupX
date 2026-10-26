import type { ModelInfo } from "@shared/protocol";

export type ModelInput = "text" | "image" | "audio" | "video";

/** The non-text inputs a composer draft actually carries. */
export function draftedInputs(attachments: Array<{ type?: string }>): ModelInput[] {
  const out = new Set<ModelInput>();
  for (const attachment of attachments) {
    const type = attachment.type ?? "";
    if (type.startsWith("image/")) out.add("image");
    else if (type.startsWith("audio/")) out.add("audio");
    else if (type.startsWith("video/")) out.add("video");
  }
  return [...out];
}

/**
 * The option list handed to the model selector.
 *
 * A model enters the list only if its catalog record declares every non-text input
 * the draft carries. A model that declares no `inputModalities` is text-only, so an
 * image attachment removes it rather than letting the request fail later.
 */
export function modelsForDraft(models: ModelInfo[], attachments: Array<{ type?: string }>): ModelInfo[] {
  const required = draftedInputs(attachments);
  if (required.length === 0) return models;
  return models.filter((model) => {
    const declared = model.inputModalities ?? ["text"];
    return required.every((input) => declared.includes(input));
  });
}

/** True when a previously selected model is no longer compatible with the draft. */
export function modelStillCompatible(model: ModelInfo | undefined, attachments: Array<{ type?: string }>): boolean {
  if (!model) return false;
  return modelsForDraft([model], attachments).length === 1;
}
