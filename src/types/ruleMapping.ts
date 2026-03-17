import type { SwiftFormatConfig, SwiftFormatRule, SwiftLintConfig, SwiftLintRule } from './interfaces';

// ── Types ────────────────────────────────────────────────────────

export type UnifiedCategory = 'formatting' | 'style' | 'lint' | 'idiomatic' | 'metrics' | 'performance' | 'documentation' | 'analyzer';

export interface OverlapPair {
    sfRule: string;
    slRule: string | string[];
    sfIsFormat: boolean;
    slCorrectable: boolean;
    defaultHandler: 'swift-format' | 'swiftlint';
}

export interface UnifiedRule {
    displayName: string;
    category: UnifiedCategory;
    tool: 'swift-format' | 'swiftlint';
    sfRule?: {
        identifier: string;
        isDefault: boolean;
        effectiveEnabled: boolean;
        isFormatRule: boolean;
    };
    slRule?: {
        identifier: string;
        optIn: boolean;
        correctable: boolean;
        kind: string;
        enabled: boolean;
        hasConfig: boolean;
    };
}

// ── Overlap pairs (19 validated) ─────────────────────────────────

export const OVERLAP_PAIRS: OverlapPair[] = [
    // Original 7 (all both-fixable)
    { sfRule: 'ReturnVoidInsteadOfEmptyTuple', slRule: 'void_return', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    { sfRule: 'DoNotUseSemicolons', slRule: 'trailing_semicolon', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    { sfRule: 'NoEmptyTrailingClosureParentheses', slRule: 'empty_parentheses_with_trailing_closure', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    { sfRule: 'OrderedImports', slRule: 'sorted_imports', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    { sfRule: 'UseTripleSlashForDocumentationComments', slRule: 'comment_spacing', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    { sfRule: 'NoVoidReturnOnFunctionSignature', slRule: 'redundant_void_return', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    { sfRule: 'NoParensAroundConditions', slRule: 'control_statement', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    // New fixable overlaps
    { sfRule: 'OmitExplicitReturns', slRule: 'implicit_return', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    { sfRule: 'UseShorthandTypeNames', slRule: 'syntactic_sugar', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    { sfRule: 'UseSynthesizedInitializer', slRule: 'unneeded_synthesized_initializer', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    // SF format + SL not correctable
    { sfRule: 'NoAccessLevelOnExtensionDeclaration', slRule: 'no_extension_access_modifier', sfIsFormat: true, slCorrectable: false, defaultHandler: 'swift-format' },
    { sfRule: 'AlwaysUseLiteralForEmptyCollectionInit', slRule: 'empty_collection_literal', sfIsFormat: true, slCorrectable: false, defaultHandler: 'swift-format' },
    { sfRule: 'NoCasesWithOnlyFallthrough', slRule: 'no_fallthrough_only', sfIsFormat: true, slCorrectable: false, defaultHandler: 'swift-format' },
    { sfRule: 'UseLetInEveryBoundCaseVariable', slRule: 'pattern_matching_keywords', sfIsFormat: true, slCorrectable: false, defaultHandler: 'swift-format' },
    { sfRule: 'UseWhereClausesInForLoops', slRule: 'for_where', sfIsFormat: true, slCorrectable: false, defaultHandler: 'swift-format' },
    { sfRule: 'OnlyOneTrailingClosureArgument', slRule: 'multiple_closures_with_trailing_closure', sfIsFormat: true, slCorrectable: false, defaultHandler: 'swift-format' },
    { sfRule: 'NoEmptyLinesOpeningClosingBraces', slRule: ['vertical_whitespace_opening_braces', 'vertical_whitespace_closing_braces'], sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    { sfRule: 'UseEarlyExits', slRule: 'superfluous_else', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    { sfRule: 'GroupNumericLiterals', slRule: 'number_separator', sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    // Both lint-only — default to SwiftLint (richer config)
    { sfRule: 'NeverForceUnwrap', slRule: 'force_unwrapping', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
    { sfRule: 'NeverUseForceTry', slRule: 'force_try', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
    { sfRule: 'NeverUseImplicitlyUnwrappedOptionals', slRule: 'implicitly_unwrapped_optional', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
    { sfRule: 'AlwaysUseLowerCamelCase', slRule: 'identifier_name', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
    { sfRule: 'TypeNamesShouldBeCapitalized', slRule: 'type_name', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
    { sfRule: 'NoPlaygroundLiterals', slRule: 'object_literal', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
];

// ── swift-format formatting rules (auto-fix) ────────────────────

export const SF_FORMAT_RULES = new Set([
    'AlwaysUseLiteralForEmptyCollectionInit', 'DoNotUseSemicolons', 'FileScopedDeclarationPrivacy',
    'FullyIndirectEnum', 'GroupNumericLiterals', 'NoAccessLevelOnExtensionDeclaration',
    'NoAssignmentInExpressions', 'NoCasesWithOnlyFallthrough', 'NoEmptyLinesOpeningClosingBraces',
    'NoEmptyTrailingClosureParentheses', 'NoLabelsInCasePatterns', 'NoLeadingUnderscores',
    'NoParensAroundConditions', 'NoVoidReturnOnFunctionSignature', 'OmitExplicitReturns',
    'OneCasePerLine', 'OneVariableDeclarationPerLine', 'OnlyOneTrailingClosureArgument',
    'OrderedImports', 'ReplaceForEachWithForLoop', 'ReturnVoidInsteadOfEmptyTuple',
    'UseEarlyExits', 'UseExplicitNilCheckInConditions', 'UseLetInEveryBoundCaseVariable',
    'UseShorthandTypeNames', 'UseSingleLinePropertyGetter', 'UseSynthesizedInitializer',
    'UseTripleSlashForDocumentationComments', 'UseWhereClausesInForLoops',
]);

// ── swift-format → category mapping ─────────────────────────────

const SF_RULE_CATEGORIES: Record<string, UnifiedCategory> = {
    // Documentation
    AllPublicDeclarationsHaveDocumentation: 'documentation',
    BeginDocumentationCommentWithOneLineSummary: 'documentation',
    ValidateDocumentationComments: 'documentation',
    UseTripleSlashForDocumentationComments: 'documentation',
    // Style (naming / conventions)
    AlwaysUseLowerCamelCase: 'style',
    TypeNamesShouldBeCapitalized: 'style',
    IdentifiersMustBeASCII: 'style',
    DontRepeatTypeInStaticProperties: 'style',
    NoLeadingUnderscores: 'style',
    NoBlockComments: 'style',
    // Lint (safety)
    NeverForceUnwrap: 'lint',
    NeverUseForceTry: 'lint',
    NeverUseImplicitlyUnwrappedOptionals: 'lint',
    AmbiguousTrailingClosureOverload: 'lint',
    AvoidRetroactiveConformances: 'lint',
    NoAssignmentInExpressions: 'lint',
    NoPlaygroundLiterals: 'lint',
    // Idiomatic
    ReplaceForEachWithForLoop: 'idiomatic',
    UseEarlyExits: 'idiomatic',
    UseWhereClausesInForLoops: 'idiomatic',
    OmitExplicitReturns: 'idiomatic',
    UseShorthandTypeNames: 'idiomatic',
    UseSynthesizedInitializer: 'idiomatic',
    UseExplicitNilCheckInConditions: 'idiomatic',
    AlwaysUseLiteralForEmptyCollectionInit: 'idiomatic',
    NoCasesWithOnlyFallthrough: 'idiomatic',
    FullyIndirectEnum: 'idiomatic',
    // Formatting (code layout)
    DoNotUseSemicolons: 'formatting',
    FileScopedDeclarationPrivacy: 'formatting',
    GroupNumericLiterals: 'formatting',
    NoAccessLevelOnExtensionDeclaration: 'formatting',
    NoEmptyLinesOpeningClosingBraces: 'formatting',
    NoEmptyTrailingClosureParentheses: 'formatting',
    NoLabelsInCasePatterns: 'formatting',
    NoParensAroundConditions: 'formatting',
    NoVoidReturnOnFunctionSignature: 'formatting',
    OneCasePerLine: 'formatting',
    OneVariableDeclarationPerLine: 'formatting',
    OnlyOneTrailingClosureArgument: 'formatting',
    OrderedImports: 'formatting',
    ReturnVoidInsteadOfEmptyTuple: 'formatting',
    UseLetInEveryBoundCaseVariable: 'formatting',
    UseSingleLinePropertyGetter: 'formatting',
};


// SwiftLint doc-oriented lint rules
const SL_DOC_RULES = new Set([
    'missing_docs', 'orphaned_doc_comment', 'local_doc_comment',
]);

// ── Helpers ──────────────────────────────────────────────────────

export function humanReadableName(identifier: string): string {
    // PascalCase → "Pascal Case"
    if (/^[A-Z]/.test(identifier)) {
        return identifier.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    }
    // snake_case → "Snake Case"
    return identifier.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function computeSfEnabled(rule: SwiftFormatRule, config: SwiftFormatConfig): boolean {
    const isDisabled = config.disabledRules.includes(rule.identifier);
    const isEnabled = config.enabledRules.includes(rule.identifier);
    return (rule.isDefault && !isDisabled) || isEnabled;
}

function computeSlEnabled(rule: SwiftLintRule, config: SwiftLintConfig): boolean {
    if (rule.analyzer) {
        return config.analyzerRules.includes(rule.identifier);
    }
    const isDefault = !rule.optIn;
    const isDisabled = config.disabledRules.includes(rule.identifier);
    const isOptedIn = config.optInRules.includes(rule.identifier);
    return (isDefault && !isDisabled) || isOptedIn;
}

function mapSlKindToCategory(rule: SwiftLintRule): UnifiedCategory {
    if (rule.analyzer) { return 'analyzer'; }
    // All fixable rules go under formatting
    if (rule.correctable) { return 'formatting'; }
    if (SL_DOC_RULES.has(rule.identifier)) { return 'documentation'; }
    switch (rule.kind) {
        case 'style': return 'style';
        case 'lint': return 'lint';
        case 'idiomatic': return 'idiomatic';
        case 'metrics': return 'metrics';
        case 'performance': return 'performance';
        default: return 'style';
    }
}

// ── Overlap resolution sets ─────────────────────────────────────

/**
 * All overlaps are hard-resolved:
 * - SL fixable → SL only (SF rule auto-disabled)
 * - SL not fixable → SF only (SL rule auto-disabled)
 */

/** SF rule IDs that should be auto-disabled (SL is fixable → SL wins) */
export const AUTO_DISABLE_SF_RULES = new Set(
    OVERLAP_PAIRS.filter((p) => p.slCorrectable).map((p) => p.sfRule),
);

/** SL rule IDs that should be auto-disabled (SL is NOT fixable → SF wins) */
export const AUTO_DISABLE_SL_RULES = new Set(
    OVERLAP_PAIRS.filter((p) => !p.slCorrectable).flatMap((p) => Array.isArray(p.slRule) ? p.slRule : [p.slRule]),
);

/** SL rules that overlap with SF formatting options and are NOT correctable.
 *  SF options always apply during formatting, so these SL lint checks are redundant.
 *  Auto-disabled (if default) and hidden from the rules list. */
export const SETTINGS_OVERLAP_HIDDEN_SL_RULES = new Set([
    'line_length',           // SF lineLength handles this
    'indentation_width',     // SF indentation + indentationCount handles this
    'switch_case_alignment', // SF indentSwitchCaseLabels handles this
]);

// ── Build unified rules ─────────────────────────────────────────

export function buildUnifiedRules(
    sfRules: SwiftFormatRule[] | null,
    sfConfig: SwiftFormatConfig,
    slRules: SwiftLintRule[] | null,
    slConfig: SwiftLintConfig,
): UnifiedRule[] {
    const result: UnifiedRule[] = [];
    const consumedSf = new Set<string>();
    const consumedSl = new Set<string>();

    // 0. Hide SL rules that overlap with SF formatting options (non-correctable)
    for (const slId of SETTINGS_OVERLAP_HIDDEN_SL_RULES) { consumedSl.add(slId); }

    // 1. Process overlaps — each pair is hard-resolved to one tool
    for (const pair of OVERLAP_PAIRS) {
        const sfRule = sfRules?.find((r) => r.identifier === pair.sfRule);
        const slRuleIds = Array.isArray(pair.slRule) ? pair.slRule : [pair.slRule];
        const slRuleObjs = slRuleIds.map((id) => slRules?.find((r) => r.identifier === id)).filter((r): r is SwiftLintRule => !!r);

        if (!sfRule && slRuleObjs.length === 0) { continue; }

        consumedSf.add(pair.sfRule);
        for (const id of slRuleIds) { consumedSl.add(id); }

        if (pair.slCorrectable) {
            // SL is fixable → show as SL-only
            for (const slRule of slRuleObjs) {
                result.push({
                    displayName: humanReadableName(slRule.identifier),
                    category: 'formatting',
                    tool: 'swiftlint',
                    slRule: {
                        identifier: slRule.identifier,
                        optIn: slRule.optIn,
                        correctable: slRule.correctable,
                        kind: slRule.kind,
                        enabled: computeSlEnabled(slRule, slConfig),
                        hasConfig: !!slConfig.ruleConfigs[slRule.identifier],
                    },
                });
            }
        } else {
            // SL is NOT fixable → show as SF-only
            if (sfRule) {
                result.push({
                    displayName: humanReadableName(sfRule.identifier),
                    category: SF_RULE_CATEGORIES[sfRule.identifier] || 'style',
                    tool: 'swift-format',
                    sfRule: {
                        identifier: sfRule.identifier,
                        isDefault: sfRule.isDefault,
                        effectiveEnabled: computeSfEnabled(sfRule, sfConfig),
                        isFormatRule: SF_FORMAT_RULES.has(sfRule.identifier),
                    },
                });
            }
        }
    }

    // 2. Remaining swift-format rules
    if (sfRules) {
        for (const rule of sfRules) {
            if (consumedSf.has(rule.identifier)) { continue; }
            result.push({
                displayName: humanReadableName(rule.identifier),
                category: SF_RULE_CATEGORIES[rule.identifier] || 'style',
                tool: 'swift-format',
                sfRule: {
                    identifier: rule.identifier,
                    isDefault: rule.isDefault,
                    effectiveEnabled: computeSfEnabled(rule, sfConfig),
                    isFormatRule: SF_FORMAT_RULES.has(rule.identifier),
                },
            });
        }
    }

    // 3. Remaining SwiftLint rules (non-analyzer)
    if (slRules) {
        for (const rule of slRules) {
            if (rule.analyzer) { continue; }
            if (consumedSl.has(rule.identifier)) { continue; }
            result.push({
                displayName: humanReadableName(rule.identifier),
                category: mapSlKindToCategory(rule),
                tool: 'swiftlint',
                slRule: {
                    identifier: rule.identifier,
                    optIn: rule.optIn,
                    correctable: rule.correctable,
                    kind: rule.kind,
                    enabled: computeSlEnabled(rule, slConfig),
                    hasConfig: !!slConfig.ruleConfigs[rule.identifier],
                },
            });
        }
    }

    return result;
}

// ── Category display order and labels ───────────────────────────

export const CATEGORY_ORDER: UnifiedCategory[] = [
    'formatting', 'style', 'idiomatic', 'lint', 'metrics', 'performance', 'documentation', 'analyzer',
];

export const CATEGORY_LABELS: Record<UnifiedCategory, string> = {
    formatting: 'Formatting',
    style: 'Style',
    idiomatic: 'Idiomatic',
    lint: 'Lint',
    metrics: 'Metrics',
    performance: 'Performance',
    documentation: 'Documentation',
    analyzer: 'Analyzer',
};

// ── Settings overlaps ───────────────────────────────────────────

export interface SettingsOverlap {
    name: string;
    formatValue: string;
    lintRuleId: string;
    lintValue: string;
    lintRuleEnabled: boolean;
    conflict: boolean;
}

export function getSettingsOverlaps(
    fmtConfig: SwiftFormatConfig,
    lintConfig: SwiftLintConfig,
    lintRules: SwiftLintRule[] | null,
): SettingsOverlap[] {
    const overlaps: SettingsOverlap[] = [];

    const isRuleEnabled = (ruleId: string): boolean => {
        const rule = lintRules?.find((r) => r.identifier === ruleId);
        if (!rule) { return false; }
        return (!rule.optIn && !lintConfig.disabledRules.includes(ruleId))
            || lintConfig.optInRules.includes(ruleId);
    };

    // Line length, indentation width, switch case alignment: handled entirely
    // by SF formatting options — SL rules auto-disabled and hidden from list.

    // File-scoped privacy
    const privateEnabled = isRuleEnabled('private_over_fileprivate');
    overlaps.push({
        name: 'File-Scoped Privacy',
        formatValue: fmtConfig.fileScopedDeclarationPrivacy,
        lintRuleId: 'private_over_fileprivate',
        lintValue: '',
        lintRuleEnabled: privateEnabled,
        conflict: privateEnabled && fmtConfig.fileScopedDeclarationPrivacy === 'fileprivate',
    });

    // Trailing commas
    const trailingEnabled = isRuleEnabled('trailing_comma');
    const commaConfig = lintConfig.ruleConfigs['trailing_comma'];
    const mandatoryComma = commaConfig?.mandatory_comma === 'true';
    const fmtAdds = fmtConfig.multiElementCollectionTrailingCommas;
    overlaps.push({
        name: 'Trailing Commas',
        formatValue: fmtAdds ? 'adds commas' : 'omits commas',
        lintRuleId: 'trailing_comma',
        lintValue: '',
        lintRuleEnabled: trailingEnabled,
        conflict: trailingEnabled && ((fmtAdds && !mandatoryComma) || (!fmtAdds && mandatoryComma)),
    });

    // Max blank lines
    const vertWsEnabled = isRuleEnabled('vertical_whitespace');
    const vertWsConfig = lintConfig.ruleConfigs['vertical_whitespace'];
    const slMaxEmpty = parseInt(vertWsConfig?.max_empty_lines || '1');
    overlaps.push({
        name: 'Max Blank Lines',
        formatValue: `${fmtConfig.maximumBlankLines}`,
        lintRuleId: 'vertical_whitespace',
        lintValue: `${slMaxEmpty}`,
        lintRuleEnabled: vertWsEnabled,
        conflict: vertWsEnabled && fmtConfig.maximumBlankLines > slMaxEmpty,
    });

    // Control flow keyword placement
    const stmtPosEnabled = isRuleEnabled('statement_position');
    const stmtPosConfig = lintConfig.ruleConfigs['statement_position'];
    const slUncuddled = stmtPosConfig?.statement_mode === 'uncuddled_else';
    const sfNewline = fmtConfig.lineBreakBeforeControlFlowKeywords;
    overlaps.push({
        name: 'Control Flow Keywords',
        formatValue: sfNewline ? 'new line' : 'same line',
        lintRuleId: 'statement_position',
        lintValue: slUncuddled ? 'uncuddled' : 'default',
        lintRuleEnabled: stmtPosEnabled,
        conflict: stmtPosEnabled && sfNewline !== slUncuddled,
    });

    return overlaps;
}
