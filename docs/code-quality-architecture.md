# Code Quality Architecture

Unified sidebar panel integrating Apple's swift-format and Realm's SwiftLint into a single Code Quality UI. swift-format ships with Xcode (always available); SwiftLint requires separate installation.

## UI Components

### Sidebar Panel: `vsxcode.codeQuality`

Single webview panel (`CodeQualityWebviewProvider`) with 5 sections:

#### Section 1: Tool Status
- swift-format version + GitHub link (always available via Xcode)
- SwiftLint version + install/update UI (Homebrew or manual)
- Custom binary path selection per tool

#### Section 2: Controls
| Toggle | Controls | Behavior |
|--------|----------|----------|
| Format on Save | `sfConfig.formatOnSave` + `slConfig.fixOnSave` | Runs SF format then SL --fix on save |
| Lint Mode | `sfConfig.lintMode` + `slConfig.enabled` | Shows diagnostics in Problems panel |
| Severity | `slConfig.severity` | normal / strict / lenient (SL only, visible when lint on) |
| Profile | Both providers | global / local rule storage |

#### Section 3: Formatting Options
SF formatting options written to `.vscode/.swift-format`. Options with fixable SL equivalents are omitted from the config (SL --fix handles them). Options with non-fixable SL equivalents are kept (SF is the only enforcer). When SL is not installed, all options are included.

**Always shown (SF only enforcer or no SL equivalent):**

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| Indentation | dropdown | Spaces | spaces / tabs |
| Indent Width | number | 4 | only when spaces |
| Line Length | number | 100 | SL `line_length` not fixable → SF handles |
| Respects Existing Line Breaks | toggle | on | |
| Break Before Each Argument | toggle | off | |
| Break Before Generic Requirements | toggle | off | |
| Break Around Multiline Chains | toggle | off | |
| Break Before Switch Case Body | toggle | off | |
| Break Between Declaration Attributes | toggle | off | |
| Indent #if/#else Blocks | toggle | on | |
| Indent Switch Case Labels | toggle | off | SL `switch_case_alignment` not fixable → SF handles |
| Prioritize Function Output Together | toggle | off | |
| Spaces Around Range Operators | toggle | off | |
| Spaces Before EOL Comments | number | 2 | |
| Reflow Multiline Strings | dropdown | never | never / always |

**Shown only when SL NOT installed (SL fixable equivalent handles when installed):**

| Option | Type | Default | SL Equivalent |
|--------|------|---------|---------------|
| Max Blank Lines | number | 1 | `vertical_whitespace` (correctable) |
| Break Before Control Flow Keywords | toggle | off | `statement_position` (correctable) |
| File-Scoped Privacy | dropdown | private | `private_over_fileprivate` (correctable) |
| Trailing Commas | toggle | on | `trailing_comma` (correctable) |

#### Section 4: Rules
Unified rules list organized into 3 collapsible groups:
- **Format Rules** — rules that auto-fix code (SF format rules + SL correctable rules)
- **Lint Rules** — rules that only report diagnostics (SF lint-only + SL non-correctable)
- **Analyzer Rules** — SL compiler-assisted rules (require build log)

Each rule row: toggle, display name, modified dot, fixable tag, gear button → expandable config panel with description, default state, configurable parameters (SL), and reset button.

#### Section 5: Excluded Paths
SL excluded paths with add/remove controls (visible when SL installed).

---

## Conflict Resolution

### Overlap Spec

When both tools have a rule covering the same behavior:
- **SL fixable** → SL only (SF rule auto-disabled, hidden from UI)
- **SL not fixable** → SF only (SL rule auto-disabled, hidden from UI)

When SL is not installed, SF overlap rules are re-enabled. When SL gets installed, they are immediately auto-disabled on next refresh.

### Enforcement

Overlap resolution runs in `postState()` via `ensureOverlapRulesResolved()` — every state update to the webview passes through it. Additional guards:
- `toggleSfRule` / `toggleSlRule` reject enabling auto-disabled rules (when other tool installed)
- `resetSfRule` preserves auto-disabled rules in `disabledRules`
- `resetAllRules` initializes disabled lists with overlap sets
- `syncFromConfigFile` triggers refresh → overlap resolution
- `writeConfigFile` (SL) skips when binary not found

### Settings Overlap Hidden Rules

SL rules that overlap with SF formatting options and are NOT fixable. SF option is the only enforcer; SL rule is auto-disabled and hidden from the rules list:
- `line_length` — SF `lineLength` handles
- `indentation_width` — SF `indentation` handles
- `switch_case_alignment` — SF `indentSwitchCaseLabels` handles

---

## Save Pipeline

When Format on Save is enabled:
1. `onWillSaveTextDocument` → `swift-format format` (applies formatting options + enabled format rules)
2. `onDidSaveTextDocument` → `swiftlint lint --fix` (applies correctable rule fixes, runs independently of lint enabled)
3. `onDidSaveTextDocument` → `swiftlint lint` (reports diagnostics, only when lint enabled)

SL --fix always gets the last word for correctable rules.

---

## swift-format Rules (43 total)

### Format Rules (21) — modify code during `swift-format format`

| Rule | Default | Overlap SL Rule | Resolution |
|------|---------|-----------------|------------|
| AlwaysUseLiteralForEmptyCollectionInit | off | `empty_collection_literal` | SF only (SL not fixable) |
| DoNotUseSemicolons | on | `trailing_semicolon` | SL only (SL fixable) |
| FileScopedDeclarationPrivacy | on | — | SF only |
| FullyIndirectEnum | on | — | SF only |
| GroupNumericLiterals | on | `number_separator` | SL only (SL fixable) |
| NoAccessLevelOnExtensionDeclaration | on | `no_extension_access_modifier` | SF only (SL not fixable) |
| NoCasesWithOnlyFallthrough | on | `no_fallthrough_only` | SF only (SL not fixable) |
| NoEmptyLinesOpeningClosingBraces | off | `vertical_whitespace_opening_braces` + `vertical_whitespace_closing_braces` | SL only (SL fixable) |
| NoEmptyTrailingClosureParentheses | on | `empty_parentheses_with_trailing_closure` | SL only (SL fixable) |
| NoLabelsInCasePatterns | on | — | SF only |
| NoParensAroundConditions | on | `control_statement` | SL only (SL fixable) |
| NoVoidReturnOnFunctionSignature | on | `redundant_void_return` | SL only (SL fixable) |
| OmitExplicitReturns | off | `implicit_return` | SL only (SL fixable) |
| OneVariableDeclarationPerLine | on | — | SF only |
| OrderedImports | on | `sorted_imports` | SL only (SL fixable) |
| ReturnVoidInsteadOfEmptyTuple | on | `void_return` | SL only (SL fixable) |
| UseExplicitNilCheckInConditions | on | — | SF only |
| UseLetInEveryBoundCaseVariable | on | `pattern_matching_keywords` | SF only (SL not fixable, opposite rule) |
| UseShorthandTypeNames | on | `syntactic_sugar` | SL only (SL fixable) |
| UseSingleLinePropertyGetter | on | — | SF only |
| UseTripleSlashForDocumentationComments | on | `comment_spacing` | SL only (SL fixable) |

### Lint-Only Rules (22) — only report during `swift-format lint`

| Rule | Default | Overlap SL Rule | Resolution |
|------|---------|-----------------|------------|
| AllPublicDeclarationsHaveDocumentation | off | — | SF only |
| AlwaysUseLowerCamelCase | on | `identifier_name` | SF only (SL not fixable) |
| AmbiguousTrailingClosureOverload | on | — | SF only |
| AvoidRetroactiveConformances | on | — | SF only |
| BeginDocumentationCommentWithOneLineSummary | off | — | SF only |
| DontRepeatTypeInStaticProperties | on | — | SF only |
| IdentifiersMustBeASCII | on | — | SF only |
| NeverForceUnwrap | off | `force_unwrapping` | SF only (SL not fixable) |
| NeverUseForceTry | off | `force_try` | SF only (SL not fixable) |
| NeverUseImplicitlyUnwrappedOptionals | off | `implicitly_unwrapped_optional` | SF only (SL not fixable) |
| NoAssignmentInExpressions | on | — | SF only |
| NoBlockComments | on | — | SF only |
| NoLeadingUnderscores | off | — | SF only |
| NoPlaygroundLiterals | on | `object_literal` | SF only (SL not fixable) |
| OneCasePerLine | on | — | SF only |
| OnlyOneTrailingClosureArgument | on | `multiple_closures_with_trailing_closure` | SF only (SL not fixable) |
| ReplaceForEachWithForLoop | on | — | SF only |
| TypeNamesShouldBeCapitalized | on | `type_name` | SF only (SL not fixable) |
| UseEarlyExits | off | `superfluous_else` | SL only (SL fixable) |
| UseSynthesizedInitializer | on | `unneeded_synthesized_initializer` | SL only (SL fixable) |
| UseWhereClausesInForLoops | off | `for_where` | SF only (SL not fixable) |
| ValidateDocumentationComments | off | — | SF only |

---

## SwiftLint Rules (250 total)

### Format Rules — correctable, auto-fix on save (91 total, shown after overlap resolution)

**Default enabled (42):**
attribute_name_spacing, closing_brace, colon, comma, comment_spacing¹, control_statement¹, duplicate_imports, empty_enum_arguments, empty_parameters, empty_parentheses_with_trailing_closure¹, function_name_whitespace, implicit_optional_initialization, leading_whitespace, legacy_cggeometry_functions, legacy_constant, legacy_constructor, legacy_nsgeometry_functions, mark, no_space_in_method_call, opening_brace, prefer_type_checking, private_over_fileprivate, private_unit_test, protocol_property_accessors_order, redundant_discardable_let, redundant_objc_attribute, redundant_sendable, redundant_void_return¹, return_arrow_whitespace, statement_position, syntactic_sugar¹, trailing_comma, trailing_newline, trailing_semicolon¹, trailing_whitespace, unneeded_break_in_switch, unneeded_override, unneeded_synthesized_initializer¹, unused_closure_parameter, unused_control_flow_label, vertical_whitespace, void_return¹

¹ = overlap winner (SF counterpart auto-disabled)

**Opt-in (49):**
async_without_await, closure_end_indentation, closure_spacing, comma_inheritance, contrasted_opening_brace, direct_return, empty_count, explicit_init, explicit_self², final_test_case, implicit_return¹, incompatible_concurrency_annotation, joined_default_parameter, literal_expression_end_indentation, lower_acl_than_parent, modifier_order, nimble_operator, non_overridable_class_declaration, number_separator¹, operator_usage_whitespace, optional_enum_case_matching, period_spacing, prefer_condition_list, prefer_key_path, prefer_self_in_static_references, prefer_self_type_over_type_of_self, prefer_zero_over_explicit_init, private_swiftui_state, redundant_nil_coalescing, redundant_self, redundant_type_annotation, return_value_from_void_function, self_binding, shorthand_optional_binding, sorted_imports¹, strong_iboutlet, superfluous_else¹, test_case_accessibility, toggle_bool, trailing_closure, unneeded_escaping, unneeded_parentheses_in_closure_argument, unneeded_throws_rethrows, untyped_error_in_catch, unused_import², unused_parameter, vertical_whitespace_between_cases, vertical_whitespace_closing_braces¹, vertical_whitespace_opening_braces¹

² = analyzer rule (also correctable)

### Lint Rules — not correctable, diagnostics only (154 total, shown after overlap resolution)

**Default enabled (58):**
blanket_disable_command, block_based_kvo, class_delegate_protocol, closure_parameter_position, compiler_protocol_init, computed_accessors_order, cyclomatic_complexity, deployment_target, discouraged_direct_init, duplicate_conditions, duplicate_enum_cases, duplicated_key_in_dictionary_literal, dynamic_inline, file_length, for_where³, force_cast, force_try³, function_body_length, function_parameter_count, generic_type_name, identifier_name³, implicit_getter, inclusive_language, invalid_swiftlint_command, is_disjoint, large_tuple, legacy_hashing, legacy_random, multiple_closures_with_trailing_closure³, nesting, no_fallthrough_only³, non_optional_string_data_conversion, notification_center_detachment, ns_number_init_as_function_reference, nsobject_prefer_isequal, optional_data_string_conversion, orphaned_doc_comment, redundant_set_access_control, redundant_string_enum_value, reduce_boolean, self_in_property_initialization, shorthand_operator, static_over_final_class, superfluous_disable_command, switch_case_alignment⁴, todo, type_body_length, type_name³, unavailable_condition, unused_enumerated, unused_optional_binding, unused_setter_value, valid_ibinspectable, vertical_parameter_alignment, void_function_in_ternary, xctfail_message, line_length⁴, indentation_width⁴

³ = auto-disabled (SF handles, SL not fixable)
⁴ = auto-disabled + hidden (SF formatting option handles)

**Opt-in (96):**
accessibility_label_for_image, accessibility_trait_for_button, anonymous_argument_in_multiline_closure, array_init, attributes, balanced_xctest_lifecycle, closure_body_length, collection_alignment, conditional_returns_on_newline, contains_over_filter_count, contains_over_filter_is_empty, contains_over_first_not_nil, contains_over_range_nil_comparison, convenience_type, discarded_notification_center_observer, discouraged_assert, discouraged_none_name, discouraged_object_literal, discouraged_optional_boolean, discouraged_optional_collection, empty_collection_literal³, empty_string, empty_xctest_method, enum_case_associated_values_count, expiring_todo, explicit_acl, explicit_enum_raw_value, explicit_top_level_acl, explicit_type_interface, extension_access_modifier, fallthrough, fatal_error_message, file_header, file_name, file_name_no_space, file_types_order, first_where, flatmap_over_map_reduce, force_unwrapping³, function_default_parameter_at_end, ibinspectable_in_extension, identical_operands, implicitly_unwrapped_optional³, last_where, legacy_multiple, legacy_objc_type, let_var_whitespace, local_doc_comment, missing_docs, multiline_arguments, multiline_arguments_brackets, multiline_call_arguments, multiline_function_chains, multiline_literal_brackets, multiline_parameters, multiline_parameters_brackets, no_empty_block, no_extension_access_modifier³, no_grouping_extension, no_magic_numbers, nslocalizedstring_key, nslocalizedstring_require_bundle, object_literal³, one_declaration_per_file, overridden_super_call, override_in_extension, pattern_matching_keywords³, prefer_asset_symbols, prefer_nimble, prefixed_toplevel_constant, private_action, private_outlet, private_subject, prohibited_interface_builder, prohibited_super_call, quick_discouraged_call, quick_discouraged_focused_test, quick_discouraged_pending_test, raw_value_for_camel_cased_codable_enum, reduce_into, required_deinit, required_enum_case, shorthand_argument, single_test_class, sorted_enum_cases, sorted_first_last, static_operator, strict_fileprivate, switch_case_on_newline, type_contents_order, unavailable_function, unhandled_throwing_task, unowned_variable_capture, vertical_parameter_alignment_on_call, weak_delegate, xct_specific_matcher, yoda_condition

### Analyzer Rules (5) — require compiler log

capture_variable, explicit_self, typesafe_array_init, unused_declaration, unused_import

---

## Overlap Summary (25 rule pairs + 3 settings)

### Rule Overlaps — SL Fixable → SL Only (13 pairs, SF auto-disabled)

| SF Rule | SL Rule | SF Type |
|---------|---------|---------|
| ReturnVoidInsteadOfEmptyTuple | void_return | format |
| DoNotUseSemicolons | trailing_semicolon | format |
| NoEmptyTrailingClosureParentheses | empty_parentheses_with_trailing_closure | format |
| OrderedImports | sorted_imports | format |
| UseTripleSlashForDocumentationComments | comment_spacing | format |
| NoVoidReturnOnFunctionSignature | redundant_void_return | format |
| NoParensAroundConditions | control_statement | format |
| OmitExplicitReturns | implicit_return | format |
| UseShorthandTypeNames | syntactic_sugar | format |
| UseSynthesizedInitializer | unneeded_synthesized_initializer | lint |
| NoEmptyLinesOpeningClosingBraces | vertical_whitespace_opening_braces + vertical_whitespace_closing_braces | format |
| UseEarlyExits | superfluous_else | lint |
| GroupNumericLiterals | number_separator | format |

### Rule Overlaps — SL Not Fixable → SF Only (12 pairs, SL auto-disabled)

| SF Rule | SL Rule | SF Type |
|---------|---------|---------|
| NoAccessLevelOnExtensionDeclaration | no_extension_access_modifier | format |
| AlwaysUseLiteralForEmptyCollectionInit | empty_collection_literal | format |
| NoCasesWithOnlyFallthrough | no_fallthrough_only | format |
| UseLetInEveryBoundCaseVariable | pattern_matching_keywords | format |
| UseWhereClausesInForLoops | for_where | lint |
| OnlyOneTrailingClosureArgument | multiple_closures_with_trailing_closure | lint |
| NeverForceUnwrap | force_unwrapping | lint |
| NeverUseForceTry | force_try | lint |
| NeverUseImplicitlyUnwrappedOptionals | implicitly_unwrapped_optional | lint |
| AlwaysUseLowerCamelCase | identifier_name | lint |
| TypeNamesShouldBeCapitalized | type_name | lint |
| NoPlaygroundLiterals | object_literal | lint |

### Settings Overlaps — SF Option vs SL Rule

| SF Option | SL Rule | SL Fixable? | Resolution |
|-----------|---------|-------------|------------|
| lineLength | line_length | no | SF only (SL hidden) |
| indentation | indentation_width | no | SF only (SL hidden) |
| indentSwitchCaseLabels | switch_case_alignment | no | SF only (SL hidden) |
| maximumBlankLines | vertical_whitespace | yes | SL only (SF option omitted from config) |
| lineBreakBeforeControlFlowKeywords | statement_position | yes | SL only (SF option omitted from config) |
| fileScopedDeclarationPrivacy | private_over_fileprivate | yes | SL only (SF option omitted from config) |
| multiElementCollectionTrailingCommas | trailing_comma | yes | SL only (SF option omitted from config) |

---

## Config Files

### `.vscode/.swift-format` (JSON)
Always created (SF ships with Xcode). Contains formatting options + rules block with all rules and their enabled/disabled state. Options with fixable SL equivalents are omitted when SL is installed.

### `.vscode/.swiftlint.yml` (YAML)
Only created when SL binary is found AND config has overrides (disabled_rules, opt_in_rules, analyzer_rules, excluded paths, or rule configs).

---

## Key Files

| File | Purpose |
|------|---------|
| `src/types/ruleMapping.ts` | Overlap pairs, category taxonomy, `buildUnifiedRules()`, auto-disable sets |
| `src/providers/codeQualityWebviewProvider.ts` | Unified webview, message handling, overlap resolution, HTML/CSS/JS |
| `src/providers/swiftFormatProvider.ts` | SF binary detection, config, formatting, linting, config file I/O |
| `src/providers/swiftLintProvider.ts` | SL binary detection, config, linting, --fix, analyzer, config file I/O |
| `src/types/interfaces.ts` | `SwiftFormatConfig`, `SwiftLintConfig`, `SwiftFormatRule`, `SwiftLintRule` |
| `src/extension.ts` | Provider registration, init flow, wiring |
