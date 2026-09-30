// Tests the fork-local `pi_mcp_config_file` setting: schema validation at the read boundary,
// settings-layer leaf precedence, pi projection filename selection, claude neutrality, the
// unchanged exclusive MCP mode env, and the untouched protocol-shaped dump payload.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { executeDumpCommand } from '../../src/cli/commands/DumpCommand.js';
import { executeExecAgentCommand } from '../../src/cli/commands/ExecAgentCommand.js';
import { projectComposition } from '../../src/projection/ProjectHarness.js';
import { discoverSettingsLoadPlan, loadSettings } from '../../src/settings/SettingsLoader.js';
import { mergeSettingsStack } from '../../src/settings/SettingsMerger.js';
import type { CompositionPlan } from '../../src/composer/Composition.js';
import { validateSchema } from '../../src/validation/SchemaValidator.js';
import { parseYamlDocument } from '../../src/validation/YamlDocument.js';

const temporaryRoots: string[] = [];

const createTemporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'outfitter-pi-mcp-config-'));
  temporaryRoots.push(root);
  return root;
};

const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const planWith = (mcp: Record<string, unknown>): CompositionPlan => ({
  agent: 'agent',
  identity: { agentBody: 'Body.' },
  loadout: {
    skills: [],
    commands: [],
    delegateSkills: [],
    subagents: [],
    mcp: Object.keys(mcp),
    mcpServers: mcp,
    extensions: [],
    extensionDeclarations: [],
    plugins: [],
  },
  warnings: [],
});

describe('pi_mcp_config_file schema validation', () => {
  it('accepts a plain .json basename', () => {
    expect(validateSchema('settings', { pi_mcp_config_file: 'mcp-adapter.json' })).toEqual({
      valid: true,
      issues: [],
    });
  });

  it.each([
    ['path separator', 'nested/mcp.json'],
    ['windows separator', 'nested\\mcp.json'],
    ['parent traversal', '../mcp.json'],
    ['embedded traversal', 'mcp..json'],
    ['non-json suffix', 'mcp.yaml'],
    ['empty value', ''],
  ])('rejects a %s', (_name, value) => {
    expect(validateSchema('settings', { pi_mcp_config_file: value }).valid).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(validateSchema('settings', { pi_mcp_config_file: 7 }).valid).toBe(false);
  });
});

describe('pi_mcp_config_file settings loading and layer precedence', () => {
  it('loads a valid basename into the merged settings', () => {
    const root = createTemporaryRoot();
    write(join(root, 'home', '.agents', 'settings.yml'), 'pi_mcp_config_file: mcp-adapter.json\n');
    write(join(root, 'project', '.agents', 'settings.local.yml'), 'default_agent: engineer\n');

    const loaded = loadSettings(
      discoverSettingsLoadPlan({ homeDirectory: join(root, 'home'), projectDirectory: join(root, 'project') }),
    );

    expect(loaded.issues).toEqual([]);
    expect(loaded.settings.piMcpConfigFile).toBe('mcp-adapter.json');
  });

  it('fails the settings load with an issue when the value is invalid', () => {
    const root = createTemporaryRoot();
    write(join(root, 'home', '.agents', 'settings.yml'), 'pi_mcp_config_file: nested/mcp.json\n');
    write(join(root, 'project', '.agents', 'settings.local.yml'), 'default_agent: engineer\n');

    const loaded = loadSettings(
      discoverSettingsLoadPlan({ homeDirectory: join(root, 'home'), projectDirectory: join(root, 'project') }),
    );

    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0]?.message).toContain('must match pattern');
    expect(loaded.settings.piMcpConfigFile).toBeUndefined();
  });

  it('follows leaf precedence so the higher-precedence layer wins', () => {
    // The settings stack is ordered lowest-precedence first (user before project-local), so a later
    // layer that declares the leaf wins — the same contract as pi_binary (settings-loader tests).
    const userLayer = { piMcpConfigFile: 'mcp-adapter.json' };
    const projectLocalLayer = { piMcpConfigFile: 'mcp-project.json' };

    expect(mergeSettingsStack([userLayer, projectLocalLayer]).piMcpConfigFile).toBe('mcp-project.json');
    expect(mergeSettingsStack([projectLocalLayer, userLayer]).piMcpConfigFile).toBe('mcp-adapter.json');
    expect(mergeSettingsStack([userLayer, {}]).piMcpConfigFile).toBe('mcp-adapter.json');
  });

  it('stays absent when no layer declares it', () => {
    expect(mergeSettingsStack([{}, {}]).piMcpConfigFile).toBeUndefined();
  });

  it('parses the YAML document before validation', () => {
    expect(parseYamlDocument('pi_mcp_config_file: mcp-adapter.json\n', '/inline')).toEqual({
      ok: true,
      document: { pi_mcp_config_file: 'mcp-adapter.json' },
    });
  });
});

describe('pi_mcp_config_file projection', () => {
  it('keeps mcp.json for pi by default', () => {
    const dir = createTemporaryRoot();
    const plan = planWith({ github: { command: 'github-mcp-server' } });

    projectComposition(plan, { harness: 'pi', rootDirectory: dir, homeDirectory: dir });

    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: { github: { command: 'github-mcp-server' } },
    });
  });

  it('materializes the configured filename and no mcp.json for pi', () => {
    const dir = createTemporaryRoot();
    const plan = planWith({ github: { command: 'github-mcp-server' } });

    projectComposition(plan, {
      harness: 'pi',
      rootDirectory: dir,
      homeDirectory: dir,
      piMcpConfigFile: 'mcp-adapter.json',
    });

    expect(JSON.parse(readFileSync(join(dir, 'mcp-adapter.json'), 'utf8'))).toEqual({
      mcpServers: { github: { command: 'github-mcp-server' } },
    });
    expect(existsSync(join(dir, 'mcp.json'))).toBe(false);
  });

  it('writes no MCP file for pi without servers, configured or not', () => {
    const unset = createTemporaryRoot();
    const configured = createTemporaryRoot();
    const plan = planWith({});

    projectComposition(plan, { harness: 'pi', rootDirectory: unset, homeDirectory: unset });
    projectComposition(plan, {
      harness: 'pi',
      rootDirectory: configured,
      homeDirectory: configured,
      piMcpConfigFile: 'mcp-adapter.json',
    });

    expect(existsSync(join(unset, 'mcp.json'))).toBe(false);
    expect(existsSync(join(configured, 'mcp-adapter.json'))).toBe(false);
  });

  it('ignores the setting for claude, which keeps mcp.json', () => {
    const dir = createTemporaryRoot();
    const plan = planWith({ github: { command: 'github-mcp-server' } });

    const projection = projectComposition(plan, {
      harness: 'claude',
      rootDirectory: dir,
      homeDirectory: dir,
      isolation: 'isolated',
      piMcpConfigFile: 'mcp-adapter.json',
    });

    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: { github: { command: 'github-mcp-server' } },
    });
    expect(existsSync(join(dir, 'mcp-adapter.json'))).toBe(false);
    expect(projection.launch.args).toEqual(
      expect.arrayContaining(['--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config']),
    );
  });
});

describe('pi_mcp_config_file end-to-end launch projection', () => {
  const tree = (settingsLine: string): { home: string; project: string } => {
    const root = createTemporaryRoot();
    const home = join(root, 'home');
    const project = join(root, 'project');
    write(join(project, '.agents', 'system-prompt.md'), 'BASE PROMPT');
    write(
      join(project, '.agents', 'mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'github-mcp-server' } } }),
    );
    write(
      join(project, '.agents', 'agents', 'engineer', 'agent.md'),
      '---\nname: engineer\nmcp: [github]\n---\n\n# Engineer\n',
    );
    if (settingsLine !== '') write(join(home, '.agents', 'settings.yml'), settingsLine);
    return { home, project };
  };

  interface Capture {
    readonly plan: { readonly env: Readonly<Record<string, string>> };
  }
  const captures: Capture[] = [];
  const launcher = (plan: Capture['plan']): Promise<number> => {
    captures.push({ plan });
    return Promise.resolve(0);
  };

  it('materializes the configured filename in the retained projection root', async () => {
    captures.length = 0;
    const { home, project } = tree('pi_mcp_config_file: mcp-adapter.json\n');

    await executeExecAgentCommand({
      homeDirectory: home,
      projectDirectory: project,
      agent: 'engineer',
      subcommand: 'list',
      subcommandArgs: [],
      launcher,
      retainProjection: true,
    });

    const rootDirectory = captures[0]?.plan.env.PI_CODING_AGENT_DIR;
    expect(rootDirectory).toBeDefined();
    expect(JSON.parse(readFileSync(join(rootDirectory, 'mcp-adapter.json'), 'utf8'))).toEqual({
      mcpServers: { github: { command: 'github-mcp-server' } },
    });
    expect(existsSync(join(rootDirectory, 'mcp.json'))).toBe(false);
    expect(captures[0]?.plan.env.PI_MCP_CONFIG_MODE).toBe('exclusive');
    rmSync(rootDirectory, { recursive: true, force: true });
  });

  it('keeps mcp.json and the exclusive mode env when the setting is absent', async () => {
    captures.length = 0;
    const { home, project } = tree('');

    await executeExecAgentCommand({
      homeDirectory: home,
      projectDirectory: project,
      agent: 'engineer',
      subcommand: 'list',
      subcommandArgs: [],
      launcher,
      retainProjection: true,
    });

    const rootDirectory = captures[0]?.plan.env.PI_CODING_AGENT_DIR;
    expect(rootDirectory).toBeDefined();
    expect(JSON.parse(readFileSync(join(rootDirectory, 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: { github: { command: 'github-mcp-server' } },
    });
    expect(captures[0]?.plan.env.PI_MCP_CONFIG_MODE).toBe('exclusive');
    rmSync(rootDirectory, { recursive: true, force: true });
  });
});

describe('pi_mcp_config_file dump neutrality', () => {
  it('leaves the dumped payload protocol-shaped with mcp.json', () => {
    const root = createTemporaryRoot();
    const home = join(root, 'home');
    const project = join(root, 'project');
    write(join(home, '.agents', 'settings.yml'), 'pi_mcp_config_file: mcp-adapter.json\n');
    write(join(project, '.agents', 'mcp.json'), '{"github":{}}');
    write(
      join(project, '.agents', 'agents', 'engineer', 'agent.md'),
      '---\nname: engineer\nmcp: [github]\n---\n\nBody.\n',
    );
    const out = join(createTemporaryRoot(), 'roots');

    executeDumpCommand({ homeDirectory: home, projectDirectory: project, agent: 'engineer', out });

    const relativeTree = (dir: string): string[] => {
      const files: string[] = [];
      const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push(relative(dir, full).split(/[/\\]/).join('/'));
        }
      };
      walk(dir);
      return files.sort();
    };
    const tree = relativeTree(join(out, '.agents'));
    expect(tree).toContain('mcp.json');
    expect(tree).not.toContain('mcp-adapter.json');
  });
});
