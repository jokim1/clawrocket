import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import type { AnySchemaObject, ValidateFunction } from 'ajv';
import _addFormats from 'ajv-formats';
import type { FormatsPluginOptions } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

// ajv-formats is CJS with only a default export; under module: "NodeNext"
// TypeScript can't see the synthesized default as callable. Cast through
// unknown to its real call signature. ajv exposes `Ajv` as a named export
// too, so we use that directly and avoid the same gotcha there.
const addFormats = _addFormats as unknown as (
  ajv: InstanceType<typeof Ajv>,
  options?: FormatsPluginOptions,
) => InstanceType<typeof Ajv>;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const schemaDir = resolve(repoRoot, 'docs/contracts/editorial-room/v0');
const fixtureDir = resolve(repoRoot, 'tests/fixtures/editorial-room/v0');

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function compile(schemaFile: string): ValidateFunction {
  return ajv.compile(
    loadJson(resolve(schemaDir, schemaFile)) as AnySchemaObject,
  );
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function expectValid(
  validate: ValidateFunction,
  fixture: unknown,
  label: string,
): void {
  const ok = validate(fixture);
  if (!ok) {
    throw new Error(
      `Validation failed for ${label}:\n${JSON.stringify(validate.errors, null, 2)}`,
    );
  }
  expect(ok).toBe(true);
}

describe('editorial-room v0 — SetupState contract', () => {
  const validateSetupState = compile('setup_state.schema.json');

  describe('schema validation', () => {
    it.each([['setup_state.minimal.json'], ['setup_state.full.json']])(
      '%s validates against the schema',
      (filename) => {
        const fixture = loadJson(resolve(fixtureDir, filename));
        expectValid(validateSetupState, fixture, filename);
      },
    );
  });

  describe('round-trip under key-sort normalization', () => {
    it.each([['setup_state.minimal.json'], ['setup_state.full.json']])(
      '%s round-trips byte-equivalent',
      (filename) => {
        const original = loadJson(resolve(fixtureDir, filename));
        const roundTripped = JSON.parse(JSON.stringify(original));
        expect(canonical(roundTripped)).toBe(canonical(original));
      },
    );
  });

  describe('schema rejects malformed input', () => {
    function baseValid(): Record<string, unknown> {
      return {
        schema_version: '0',
        setup_version: 1,
        deliverable_type: 'longform_post',
        voice_page_slug: 'voice/gamemakers-2026',
        length_target: null,
        destination: 'plain_md',
        audience_persona_slugs: ['persona/ankit-indie-dev'],
        llm_room_agent_profile_ids: ['agent/argus', 'agent/scribe'],
        scoring_pipeline_slug: 'scoring_pipeline/gamemakers_default',
        updated_at: '2026-04-30T00:00:00.000Z',
        updated_by_user_id: 'user_local_joseph',
      };
    }

    it('baseline: baseValid() validates (sanity check)', () => {
      expectValid(validateSetupState, baseValid(), 'baseValid');
    });

    it('rejects missing required field (setup_version)', () => {
      const invalid = baseValid();
      delete invalid.setup_version;
      expect(validateSetupState(invalid)).toBe(false);
    });

    it('rejects unknown deliverable_type', () => {
      const invalid = { ...baseValid(), deliverable_type: 'epic_novel' };
      expect(validateSetupState(invalid)).toBe(false);
    });

    it('rejects schema_version other than "0"', () => {
      const invalid = { ...baseValid(), schema_version: '1' };
      expect(validateSetupState(invalid)).toBe(false);
    });

    it('rejects audience_persona_slugs > 3 (max cap)', () => {
      const invalid = {
        ...baseValid(),
        audience_persona_slugs: ['p1', 'p2', 'p3', 'p4'],
      };
      expect(validateSetupState(invalid)).toBe(false);
    });

    it('rejects empty audience_persona_slugs (min cap)', () => {
      const invalid = { ...baseValid(), audience_persona_slugs: [] };
      expect(validateSetupState(invalid)).toBe(false);
    });

    it('rejects llm_room_agent_profile_ids < 2 (min cap)', () => {
      const invalid = {
        ...baseValid(),
        llm_room_agent_profile_ids: ['agent/argus'],
      };
      expect(validateSetupState(invalid)).toBe(false);
    });

    it('rejects unknown additional property', () => {
      const invalid = { ...baseValid(), surprise_field: 'nope' };
      expect(validateSetupState(invalid)).toBe(false);
    });

    it('rejects non-integer setup_version', () => {
      const invalid = { ...baseValid(), setup_version: 1.5 };
      expect(validateSetupState(invalid)).toBe(false);
    });

    it('rejects malformed updated_at (not ISO date-time)', () => {
      const invalid = { ...baseValid(), updated_at: 'yesterday' };
      expect(validateSetupState(invalid)).toBe(false);
    });

    it('rejects length_target with min_words missing', () => {
      const invalid = { ...baseValid(), length_target: { max_words: 2500 } };
      expect(validateSetupState(invalid)).toBe(false);
    });
  });
});
