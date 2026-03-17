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
    tool: 'swift-format' | 'swiftlint' | 'overlap';
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
    overlap?: {
        activeHandler: 'swift-format' | 'swiftlint' | 'both';
        sfIsFormat: boolean;
        slCorrectable: boolean;
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
    { sfRule: 'NoEmptyLinesOpeningClosingBraces', slRule: ['vertical_whitespace_opening_braces', 'vertical_whitespace_closing_braces'], sfIsFormat: true, slCorrectable: true, defaultHandler: 'swift-format' },
    // Both lint-only — default to SwiftLint (richer config)
    { sfRule: 'NeverForceUnwrap', slRule: 'force_unwrapping', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
    { sfRule: 'NeverUseForceTry', slRule: 'force_try', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
    { sfRule: 'NeverUseImplicitlyUnwrappedOptionals', slRule: 'implicitly_unwrapped_optional', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
    { sfRule: 'AlwaysUseLowerCamelCase', slRule: 'identifier_name', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
    { sfRule: 'TypeNamesShouldBeCapitalized', slRule: 'type_name', sfIsFormat: false, slCorrectable: false, defaultHandler: 'swiftlint' },
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

// ── SwiftLint style rules that are formatting-oriented ──────────

const SL_FORMATTING_STYLE_RULES = new Set([
    'trailing_whitespace', 'vertical_whitespace', 'vertical_whitespace_between_cases',
    'vertical_whitespace_closing_braces', 'vertical_whitespace_opening_braces',
    'colon', 'comma', 'opening_brace', 'closing_brace', 'leading_whitespace',
    'trailing_newline', 'return_arrow_whitespace', 'statement_position',
    'function_name_whitespace', 'attribute_name_spacing', 'no_space_in_method_call',
    'closure_spacing', 'operator_usage_whitespace', 'period_spacing',
    'protocol_property_accessors_order', 'switch_case_alignment',
    'redundant_discardable_let', 'empty_parameters', 'empty_enum_arguments',
    'implicit_optional_initialization', 'trailing_comma',
    'indentation_width', 'closure_end_indentation', 'literal_expression_end_indentation',
    'collection_alignment', 'let_var_whitespace', 'number_separator',
]);

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
    if (SL_DOC_RULES.has(rule.identifier)) { return 'documentation'; }
    switch (rule.kind) {
        case 'style': return SL_FORMATTING_STYLE_RULES.has(rule.identifier) ? 'formatting' : 'style';
        case 'lint': return 'lint';
        case 'idiomatic': return 'idiomatic';
        case 'metrics': return 'metrics';
        case 'performance': return 'performance';
        default: return 'style';
    }
}

// ── Correctable overlap SF rules (auto-disabled, SL handles these) ──

/** SF rule identifiers whose SL counterpart is correctable — shown as SL-only */
export const CORRECTABLE_OVERLAP_SF_RULES = new Set(
    OVERLAP_PAIRS.filter((p) => p.slCorrectable).map((p) => p.sfRule),
);

// ── Build unified rules ─────────────────────────────────────────

export function buildUnifiedRules(
    sfRules: SwiftFormatRule[] | null,
    sfConfig: SwiftFormatConfig,
    slRules: SwiftLintRule[] | null,
    slConfig: SwiftLintConfig,
    overlapPrefs: Record<string, 'swift-format' | 'swiftlint' | 'both'>,
): UnifiedRule[] {
    const result: UnifiedRule[] = [];
    const consumedSf = new Set<string>();
    const consumedSl = new Set<string>();

    // 1. Process overlaps
    for (const pair of OVERLAP_PAIRS) {
        const sfRule = sfRules?.find((r) => r.identifier === pair.sfRule);
        const slRuleIds = Array.isArray(pair.slRule) ? pair.slRule : [pair.slRule];
        const slRuleObjs = slRuleIds.map((id) => slRules?.find((r) => r.identifier === id)).filter((r): r is SwiftLintRule => !!r);

        if (!sfRule && slRuleObjs.length === 0) { continue; }

        consumedSf.add(pair.sfRule);
        for (const id of slRuleIds) { consumedSl.add(id); }

        // Correctable overlaps: SF side is auto-disabled, show SL rule only
        if (pair.slCorrectable && slRuleObjs.length > 0) {
            for (const slRule of slRuleObjs) {
                result.push({
                    displayName: humanReadableName(slRule.identifier),
                    category: mapSlKindToCategory(slRule),
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
            continue;
        }

        // Non-correctable overlaps: show as overlap with handler selection
        const handler = overlapPrefs[pair.sfRule] || pair.defaultHandler;

        result.push({
            displayName: humanReadableName(pair.sfRule),
            category: SF_RULE_CATEGORIES[pair.sfRule] || 'style',
            tool: 'overlap',
            sfRule: sfRule ? {
                identifier: sfRule.identifier,
                isDefault: sfRule.isDefault,
                effectiveEnabled: computeSfEnabled(sfRule, sfConfig),
                isFormatRule: pair.sfIsFormat,
            } : undefined,
            slRule: slRuleObjs[0] ? {
                identifier: slRuleObjs[0].identifier,
                optIn: slRuleObjs[0].optIn,
                correctable: slRuleObjs[0].correctable,
                kind: slRuleObjs[0].kind,
                enabled: computeSlEnabled(slRuleObjs[0], slConfig),
                hasConfig: !!slConfig.ruleConfigs[slRuleObjs[0].identifier],
            } : undefined,
            overlap: { activeHandler: handler, sfIsFormat: pair.sfIsFormat, slCorrectable: pair.slCorrectable },
        });
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

    // Line length
    const lineLengthEnabled = isRuleEnabled('line_length');
    const lineConfig = lintConfig.ruleConfigs['line_length'];
    const lintWarning = parseInt(lineConfig?.warning || '120');
    overlaps.push({
        name: 'Line Length',
        formatValue: `${fmtConfig.lineLength}`,
        lintRuleId: 'line_length',
        lintValue: `${lintWarning}`,
        lintRuleEnabled: lineLengthEnabled,
        conflict: lineLengthEnabled && fmtConfig.lineLength > lintWarning,
    });

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

    return overlaps;
}
