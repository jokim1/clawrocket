export interface ModelCapabilities {
  supports_tools: boolean;
  supports_streaming: boolean;
  supports_vision: boolean;
  supports_json_schema: boolean;
  supports_long_context: boolean;
  extra?: Record<string, unknown>;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  supports_tools: false,
  supports_streaming: true,
  supports_vision: false,
  supports_json_schema: false,
  supports_long_context: false,
};

export function normalizeCapabilities(
  value: Partial<ModelCapabilities> | undefined,
): ModelCapabilities {
  return {
    ...DEFAULT_CAPABILITIES,
    ...value,
  };
}
