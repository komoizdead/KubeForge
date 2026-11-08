export type JsonSchema = Record<string, unknown>;

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const noInputSchema: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
