import { readFileSync, readdirSync } from 'node:fs';
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

// Auto-load all schemas in v0/ so $refs across files resolve at compile time.
const schemaFilenames = readdirSync(schemaDir).filter((f) =>
  f.endsWith('.schema.json'),
);
for (const file of schemaFilenames) {
  ajv.addSchema(loadJson(resolve(schemaDir, file)) as AnySchemaObject);
}

function validatorFor(schemaFile: string): ValidateFunction {
  const schema = loadJson(resolve(schemaDir, schemaFile)) as AnySchemaObject;
  const id = schema.$id;
  if (typeof id !== 'string') {
    throw new Error(`${schemaFile} is missing $id`);
  }
  const validate = ajv.getSchema(id);
  if (!validate) {
    throw new Error(`No validator registered for ${schemaFile} (id ${id})`);
  }
  return validate;
}

// Convention: a fixture named `<base>.<variant>.json` validates against
// `<base>.schema.json`. e.g., `theme.derived_from_pcp.json` →
// `theme.schema.json`; `setup_state.minimal.json` → `setup_state.schema.json`.
// A few fixtures in EDITORIAL_ROOM_CONTRACT.md §9.1 use a different shape
// (e.g., `point_with_evidence.example.json` for the `point` schema, or
// `point_note_blocks.example.json` plural-named for the singular schema);
// those are listed in `FIXTURE_SCHEMA_OVERRIDES`.
const FIXTURE_SCHEMA_OVERRIDES: Record<string, string> = {
  'point_with_evidence.example.json': 'point.schema.json',
  'point_note_blocks.example.json': 'point_note_block.schema.json',
  'suggestions.adv_cut.json': 'suggestion.schema.json',
  'suggestions.opus_review.json': 'suggestion.schema.json',
};

// Fixtures whose top-level value is an array of <schema> rather than a single
// <schema>. We validate each element separately.
const FIXTURES_AS_ARRAY: ReadonlySet<string> = new Set([
  'point_note_blocks.example.json',
  'suggestions.adv_cut.json',
  'suggestions.opus_review.json',
]);

function schemaFileForFixture(fixtureFile: string): string {
  if (fixtureFile in FIXTURE_SCHEMA_OVERRIDES) {
    return FIXTURE_SCHEMA_OVERRIDES[fixtureFile];
  }
  const base = fixtureFile.split('.')[0];
  return `${base}.schema.json`;
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

const ALL_FIXTURES = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'));

describe('editorial-room v0 contracts', () => {
  describe('all fixtures validate against their schemas', () => {
    it.each(ALL_FIXTURES.map((f) => [f, schemaFileForFixture(f)]))(
      '%s validates against %s',
      (fixtureFile, schemaFile) => {
        const validate = validatorFor(schemaFile);
        const fixture = loadJson(resolve(fixtureDir, fixtureFile));
        if (FIXTURES_AS_ARRAY.has(fixtureFile)) {
          if (!Array.isArray(fixture)) {
            throw new Error(
              `${fixtureFile} expected to be a JSON array (FIXTURES_AS_ARRAY)`,
            );
          }
          fixture.forEach((elem, idx) => {
            expectValid(validate, elem, `${fixtureFile}[${idx}]`);
          });
        } else {
          expectValid(validate, fixture, fixtureFile);
        }
      },
    );
  });

  describe('all fixtures round-trip byte-equivalent under key-sort', () => {
    it.each(ALL_FIXTURES.map((f) => [f]))('%s', (fixtureFile) => {
      const original = loadJson(resolve(fixtureDir, fixtureFile));
      const roundTripped = JSON.parse(JSON.stringify(original));
      expect(canonical(roundTripped)).toBe(canonical(original));
    });
  });

  describe('SetupState — schema rejects malformed input', () => {
    const validateSetupState = validatorFor('setup_state.schema.json');

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

  describe('Theme — cross-schema $ref resolution', () => {
    const validateTheme = validatorFor('theme.schema.json');

    it('rejects malformed pcp_provenance via $ref (missing required field)', () => {
      const fixture = loadJson(
        resolve(fixtureDir, 'theme.derived_from_pcp.json'),
      ) as Record<string, unknown>;
      const provenance = fixture.pcp_provenance as Record<string, unknown>;
      delete provenance.derived_at;
      expect(validateTheme(fixture)).toBe(false);
    });

    it('accepts theme with both pcp_provenance and panel_provenance null', () => {
      const fixture = loadJson(resolve(fixtureDir, 'theme.example.json'));
      expectValid(validateTheme, fixture, 'theme.example.json');
    });
  });
});
