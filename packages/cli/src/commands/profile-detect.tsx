/**
 * `transmuter profile-detect` command — detect compiler profile and show rule weights.
 *
 * Designed to be run from the decomp project root. It reads decomp.yaml,
 * detects the compiler profile, and displays a decision tree showing why
 * a particular profile was selected, followed by the rule table.
 */
import { loadDecompYaml, searchDecompYaml } from '@match-kit/decomp-yaml/files';
import { type Language, type ProfileTrace, type ResolvedRule, getProfile, getRuleWeights } from '@transmuter/core';
import { Box, Text, render } from 'ink';
import React from 'react';

import { transmuterBlock } from '../config.js';

export interface ProfileDetectArgs {
  profile?: string;
  compiler?: string;
  cwd?: string;
  config?: string;
  language?: string;
}

// ---------------------------------------------------------------------------
// Decision tree rendering
// ---------------------------------------------------------------------------

const PASS = '\u2713'; // ✓
const FAIL = '\u2717'; // ✗
const ARROW = '\u2192'; // →

function CheckLine({
  passed,
  children,
  indent,
}: {
  passed: boolean;
  children: React.ReactNode;
  indent?: number;
}): React.ReactElement {
  const prefix = indent ? '  '.repeat(indent) : '';
  return (
    <Box>
      <Text>
        {prefix}
        <Text color={passed ? 'green' : 'red'}>[{passed ? PASS : FAIL}]</Text> {children}
      </Text>
    </Box>
  );
}

function DetectionTree({
  trace,
  decompYamlFound,
}: {
  trace: ProfileTrace;
  decompYamlFound: boolean;
}): React.ReactElement {
  // Case 1: Explicit --profile flag
  if (trace.explicitProfile) {
    return (
      <Box flexDirection="column">
        <CheckLine passed>{`--profile ${trace.explicitProfile} flag provided`}</CheckLine>
        <Box>
          <Text bold>{ARROW} Using </Text>
          <Text bold color="green">
            {trace.profile.id}
          </Text>
          <Text bold> profile</Text>
        </Box>
      </Box>
    );
  }

  // Cases 2-4: Auto-detection
  return (
    <Box flexDirection="column">
      <CheckLine passed={false}>No --profile flag provided, auto-detecting...</CheckLine>

      {/* decomp.yaml step */}
      <CheckLine passed={decompYamlFound} indent={1}>
        {decompYamlFound ? 'decomp.yaml found' : 'decomp.yaml not found'}
      </CheckLine>

      {decompYamlFound && (
        <>
          {/* Compiler command step */}
          {trace.compilerCommand ? (
            <CheckLine passed={trace.compilerMatched} indent={2}>
              {trace.compilerMatched ? (
                <Text>
                  Compiler command matched a known profile: <Text bold>{trace.compilerCommand}</Text>
                </Text>
              ) : (
                <Text>
                  Compiler command did not match any known profile: <Text bold>{trace.compilerCommand}</Text>
                </Text>
              )}
            </CheckLine>
          ) : (
            <CheckLine passed={false} indent={2}>
              No compiler command in decomp.yaml or --compiler flag
            </CheckLine>
          )}

          {/* Platform step (only shown if compiler didn't match) */}
          {!trace.compilerMatched && (
            <CheckLine passed={trace.platformMatched} indent={2}>
              {trace.platformMatched ? (
                <Text>
                  platform property maps to a profile: <Text bold>{trace.platform}</Text>
                </Text>
              ) : (
                <Text>
                  platform property did not map to any profile: <Text bold>{trace.platform}</Text>
                </Text>
              )}
            </CheckLine>
          )}
        </>
      )}

      {/* No decomp.yaml: show compiler flag check */}
      {!decompYamlFound &&
        (trace.compilerCommand ? (
          <CheckLine passed={trace.compilerMatched} indent={1}>
            {trace.compilerMatched ? (
              <Text>
                --compiler flag matched a known profile: <Text bold>{trace.compilerCommand}</Text>
              </Text>
            ) : (
              <Text>
                --compiler flag did not match any known profile: <Text bold>{trace.compilerCommand}</Text>
              </Text>
            )}
          </CheckLine>
        ) : (
          <CheckLine passed={false} indent={1}>
            No --compiler flag provided
          </CheckLine>
        ))}

      <Box>
        <Text bold>{ARROW} Using </Text>
        <Text bold color="green">
          {trace.profile.id}
        </Text>
        <Text bold> profile</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Weight cell rendering
// ---------------------------------------------------------------------------

function WeightCell({ rule }: { rule: ResolvedRule }): React.ReactElement {
  const { profileWeight, userWeight, userDisabled, profileDisabled } = rule;

  // User explicitly disabled via disabledRules
  if (userDisabled && !profileDisabled) {
    return (
      <Text>
        <Text strikethrough dimColor>
          {profileWeight}
        </Text>{' '}
        <Text color="red" bold>
          0
        </Text>
        {String('').padEnd(Math.max(0, 6 - String(profileWeight).length))}
      </Text>
    );
  }

  // Profile disabled, user tries to override weight — still disabled
  if (profileDisabled && userWeight !== undefined) {
    return (
      <Text>
        <Text color="red" bold>
          0
        </Text>{' '}
        <Text strikethrough dimColor>
          {userWeight}
        </Text>
        {String('').padEnd(Math.max(0, 6 - String(userWeight).length))}
      </Text>
    );
  }

  // Profile disabled (no user override)
  if (profileDisabled) {
    return <Text color="red">{String(0).padEnd(8)}</Text>;
  }

  // User overrides weight
  if (userWeight !== undefined && userWeight !== profileWeight) {
    return (
      <Text>
        <Text strikethrough dimColor>
          {profileWeight}
        </Text>{' '}
        <Text color="yellow" bold>
          {userWeight}
        </Text>
        {String('').padEnd(Math.max(0, 6 - String(userWeight).length))}
      </Text>
    );
  }

  // No override — show plain weight
  return <Text bold>{String(profileWeight).padEnd(8)}</Text>;
}

// ---------------------------------------------------------------------------
// Rule table + main app
// ---------------------------------------------------------------------------

function ProfileDetectApp({
  trace,
  decompYamlFound,
  language,
  rules,
}: {
  trace: ProfileTrace;
  decompYamlFound: boolean;
  language?: Language;
  rules: ResolvedRule[];
}): React.ReactElement {
  const { profile } = trace;
  const filtered = language ? rules.filter((r) => r.languages.includes(language)) : rules;

  // Sort by effective weight descending
  const sorted = [...filtered].sort((a, b) => b.effectiveWeight - a.effectiveWeight);

  const hasOverrides = sorted.some((r) => r.userWeight !== undefined || r.userDisabled);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <DetectionTree trace={trace} decompYamlFound={decompYamlFound} />
        {profile.description && (
          <Box marginTop={1}>
            <Text dimColor>{profile.description}</Text>
          </Box>
        )}
      </Box>

      <Box>
        <Text bold>
          {'  Rule'.padEnd(32)}
          {'Lang'.padEnd(12)}
          {'Weight'.padEnd(10)}Description
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          {'  ' + '─'.repeat(30) + '  ' + '─'.repeat(10) + '  ' + '─'.repeat(8) + '  ' + '─'.repeat(40)}
        </Text>
      </Box>

      {sorted.map((rule) => {
        const disabled = rule.profileDisabled || rule.userDisabled;
        return (
          <Box key={rule.ruleId}>
            <Text>
              {'  '}
              <Text color={disabled ? 'red' : undefined}>{rule.ruleId.padEnd(30)}</Text>
              {'  '}
              <Text dimColor>{rule.languages.join(',').padEnd(10)}</Text>
              {'  '}
            </Text>
            <WeightCell rule={rule} />
            <Text>
              {'  '}
              <Text dimColor={disabled}>
                {rule.description}
                {rule.profileDisabled ? ' (profile disabled)' : ''}
                {rule.userDisabled ? ' (decomp.yaml disabled)' : ''}
              </Text>
            </Text>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>
          {sorted.length} rules total, {sorted.filter((r) => r.effectiveWeight > 0).length} active
          {language ? ` (filtered: ${language})` : ''}
          {hasOverrides ? ' (overrides from decomp.yaml shown in yellow)' : ''}
        </Text>
      </Box>
    </Box>
  );
}

export async function profileDetectCommand(args: ProfileDetectArgs): Promise<void> {
  const loaded = args.config ? loadDecompYaml(args.config) : searchDecompYaml(args.cwd);
  const transmuterConfig = transmuterBlock(loaded);

  const compilerCommand = args.compiler ?? transmuterConfig?.compiler;
  const platform = loaded?.config.platform;

  const trace = getProfile({ profileId: args.profile, compilerCommand, platform });

  const rules = getRuleWeights({
    profileId: args.profile,
    compilerCommand,
    platform,
    userRuleWeights: transmuterConfig?.ruleWeights,
    userDisabledRules: transmuterConfig?.disabledRules,
  });

  const language = args.language as Language | undefined;

  render(<ProfileDetectApp trace={trace} decompYamlFound={loaded !== null} language={language} rules={rules} />);
}
