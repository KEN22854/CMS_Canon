/** Appended to the system prompt for providers without a native schema-less JSON mode. */
export const JSON_ONLY_INSTRUCTION = 'Respond with a single valid JSON value and nothing else — no prose, no code fences.';

export function dataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}
