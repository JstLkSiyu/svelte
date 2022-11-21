import { isIdentifierStart, isIdentifierChar, parse as acornParse } from 'acorn';
import fragment from './state/fragment';
import { regex_whitespace } from '../utils/patterns';
import { reserved } from '../utils/names';
import full_char_code_at from '../utils/full_char_code_at';
import { TemplateNode, Ast, ParserOptions, Fragment, Style, Script, VisualSchema, VisualNodeAttr, VisualNodeIntl, VisualElementNode, VisualExprNode, VisualTextNode } from '../interfaces';
import error from '../utils/error';
import parser_errors from './errors';
import { Program } from 'estree';
import { parseExpressionAt } from 'code-red';
// @ts-ignore
import parseCss from 'css-tree/parser';
import { walk } from 'estree-walker';

type ParserState = (parser: Parser) => (ParserState | void);

interface LastAutoClosedTag {
	tag: string;
	reason: string;
	depth: number;
}

const regex_position_indicator = / \(\d+:\d+\)$/;

export class Parser {
	readonly template: string;
	readonly filename?: string;
	readonly customElement: boolean;
	readonly css_mode: 'injected' | 'external' | 'none' | boolean;

	index = 0;
	stack: TemplateNode[] = [];

	html: Fragment;
	css: Style[] = [];
	js: Script[] = [];
	meta_tags = {};
	last_auto_closed_tag?: LastAutoClosedTag;

	constructor(template: string, options: ParserOptions) {
		if (typeof template !== 'string') {
			throw new TypeError('Template must be a string');
		}

		this.template = template.trimRight();
		this.filename = options.filename;
		this.customElement = options.customElement;
		this.css_mode = options.css;

		this.html = {
			start: null,
			end: null,
			type: 'Fragment',
			children: []
		};

		this.stack.push(this.html);

		let state: ParserState = fragment;

		while (this.index < this.template.length) {
			state = state(this) || fragment;
		}

		if (this.stack.length > 1) {
			const current = this.current();

			const type = current.type === 'Element' ? `<${current.name}>` : 'Block';
			const slug = current.type === 'Element' ? 'element' : 'block';

			this.error({
				code: `unclosed-${slug}`,
				message: `${type} was left open`
			}, current.start);
		}

		if (state !== fragment) {
			this.error({
				code: 'unexpected-eof',
				message: 'Unexpected end of input'
			});
		}

		if (this.html.children.length) {
			let start = this.html.children[0].start;
			while (regex_whitespace.test(template[start])) start += 1;

			let end = this.html.children[this.html.children.length - 1].end;
			while (regex_whitespace.test(template[end - 1])) end -= 1;

			this.html.start = start;
			this.html.end = end;
		} else {
			this.html.start = this.html.end = null;
		}
	}

	current() {
		return this.stack[this.stack.length - 1];
	}

	acorn_error(err: any) {
		this.error({
			code: 'parse-error',
			message: err.message.replace(regex_position_indicator, '')
		}, err.pos);
	}

	error({ code, message }: { code: string; message: string }, index = this.index) {
		error(message, {
			name: 'ParseError',
			code,
			source: this.template,
			start: index,
			filename: this.filename
		});
	}

	eat(str: string, required?: boolean, error?: { code: string, message: string }) {
		if (this.match(str)) {
			this.index += str.length;
			return true;
		}

		if (required) {
			this.error(error ||
				(this.index === this.template.length
					? parser_errors.unexpected_eof_token(str)
					: parser_errors.unexpected_token(str))
			);
		}

		return false;
	}

	match(str: string) {
		return this.template.slice(this.index, this.index + str.length) === str;
	}

	match_regex(pattern: RegExp) {
		const match = pattern.exec(this.template.slice(this.index));
		if (!match || match.index !== 0) return null;

		return match[0];
	}

	allow_whitespace() {
		while (
			this.index < this.template.length &&
			regex_whitespace.test(this.template[this.index])
		) {
			this.index++;
		}
	}

	read(pattern: RegExp) {
		const result = this.match_regex(pattern);
		if (result) this.index += result.length;
		return result;
	}

	read_identifier(allow_reserved = false) {
		const start = this.index;

		let i = this.index;

		const code = full_char_code_at(this.template, i);
		if (!isIdentifierStart(code, true)) return null;

		i += code <= 0xffff ? 1 : 2;

		while (i < this.template.length) {
			const code = full_char_code_at(this.template, i);

			if (!isIdentifierChar(code, true)) break;
			i += code <= 0xffff ? 1 : 2;
		}

		const identifier = this.template.slice(this.index, this.index = i);

		if (!allow_reserved && reserved.has(identifier)) {
			this.error({
				code: 'unexpected-reserved-word',
				message: `'${identifier}' is a reserved word in JavaScript and cannot be used here`
			}, start);
		}

		return identifier;
	}

	read_until(pattern: RegExp, error_message?: Parameters<Parser['error']>[0]) {
		if (this.index >= this.template.length) {
			this.error(error_message || {
				code: 'unexpected-eof',
				message: 'Unexpected end of input'
			});
		}

		const start = this.index;
		const match = pattern.exec(this.template.slice(start));

		if (match) {
			this.index = start + match.index;
			return this.template.slice(start, this.index);
		}

		this.index = this.template.length;
		return this.template.slice(start);
	}

	require_whitespace() {
		if (!regex_whitespace.test(this.template[this.index])) {
			this.error({
				code: 'missing-whitespace',
				message: 'Expected whitespace'
			});
		}

		this.allow_whitespace();
	}
}

export default function parse(
	template: string,
	options: ParserOptions = {}
): Ast {
	const parser = new Parser(template, options);

	// TODO we may want to allow multiple <style> tags —
	// one scoped, one global. for now, only allow one
	if (parser.css.length > 1) {
		parser.error(parser_errors.duplicate_style, parser.css[1].start);
	}

	const instance_scripts = parser.js.filter(script => script.context === 'default');
	const module_scripts = parser.js.filter(script => script.context === 'module');

	if (instance_scripts.length > 1) {
		parser.error(parser_errors.invalid_script_instance, instance_scripts[1].start);
	}

	if (module_scripts.length > 1) {
		parser.error(parser_errors.invalid_script_module, module_scripts[1].start);
	}

	return {
		html: parser.html,
		css: parser.css[0],
		instance: instance_scripts[0],
		module: module_scripts[0]
	};
}

class VisualSchemaParser {
	getHtml = () => null;
	getCss = () => null;
	getInstance = () => null;
	getModule = () => null;
	constructor(schema: VisualSchema, customTag = 'div') {
		const {
			root,
			css = String(),
			js = String(),
			// props = [],
			// states = [],
		} = schema;
		const rootAst = this.parseNode(root);
		const tagOptions = this.parseSvelteOptions([{
			type: 'Attribute',
			name: 'tag',
			value: [customTag],
		}]);
		const htmlContent = [tagOptions, rootAst];
		const htmlFragment = this.createFragment(htmlContent);
		this.getHtml = () => htmlFragment;
		this.getCss = () => this.parseCss(css);
		this.getInstance = () => this.parseJs(js, 'module');
	}
	parseSvelteOptions(attributes: VisualNodeAttr[]) {
		const ast = {
			type: 'Options',
			name: 'svelte:options',
			attributes: attributes.map(attr => this.parseAttribute(attr)),
			children: [],
			...this.createLocation(),
		};
		return ast;
	}
	parseText(raw: string, data?: string) {
		const ast = {
			type: 'Text',
			raw,
			data: data ?? raw,
			...this.createLocation(),
		};
		return ast;
	}
	parseAttribute(attribute: VisualNodeAttr) {
		const { type, name, value } = attribute;
		const ast = {
			type,
			name,
			value: value.map(val => this.parseText(val)),
			...this.createLocation(),
		};
		return ast;
	}
	parseNode(node: VisualNodeIntl) {
		if (this.isElementNode(node)) {
			return this.parseElementNode(node.tagName, node.attributes, node.children);
		} else if (this.isExprNode(node)) {
			return this.parseExpr(node.expression, true);
		} else if (this.isTextNode(node)) {
			return this.parseText(node.text);
		} else {
			return null;
		}
	}
	parseLogicNode() {
		//
	}
	parseEventHandler(event: string, handleExpr: string) {
		const ast = {
			type: 'EventHandler',
			name: event,
			modifiers: [],
			expression: this.parseExpr(handleExpr),
			...this.createLocation(),
		};
		return ast;
	}
	isElementNode(node: VisualNodeIntl): node is VisualElementNode {
		return node.type === 'element';
	}
	isExprNode(node: VisualNodeIntl): node is VisualExprNode {
		return node.type === 'expr';
	}
	isTextNode(node: VisualNodeIntl): node is VisualTextNode {
		return node.type === 'text';
	}
	parseElementNode(tagName: string, attributes: VisualNodeAttr[], children: VisualNodeIntl[]) {
		const ast = {
			type: 'Element',
			name: tagName,
			attributes: attributes.reduce((attrs, attr) => {
				switch (attr.type) {
					case 'EventHandler': {
						attrs.push(
							this.parseEventHandler(attr.name, attr.value[0])
						);
						break;
					}
					default: {}
				}
				return attrs;
			}, []),
			children: children.reduce((children, child) => {
				const childAst = this.parseNode(child);
				if (childAst) {
					children.push(childAst);
				}
				return children;
			}, []),
			...this.createLocation(),
		};
		return ast;
	}
	createFragment(children: any) {
		const ast = {
			type: 'Fragment',
			children,
			...this.createLocation()
		};
		return ast;
	}
	createLocation(withLocation = false, startAndEnd?: { start: number, end: number }) {
		const { start, end } = startAndEnd ?? { start: 0, end: 0 };
		const location = { start, end };
		const emptyLoc = { line:0, column: 0 };
		if (withLocation) {
			Object.assign(location, {
				loc: {
					start: emptyLoc,
					end: emptyLoc
				}
			});
		}
		return location;
	}
	parseJs(js: string, context: string) {
		const ast = {
			type: 'Script' as const,
			context,
			content: acornParse(js, {
				sourceType: 'module',
				ecmaVersion: 12,
			}) as any as Program,
			...this.createLocation()
		};
		return ast;
	}
	parseExpr(expr: string, wrapMustache = false) {
		const exprBlock = parseExpressionAt(expr, 0, {
			sourceType: 'module',
			ecmaVersion: 12,
		});
		let ast = exprBlock;
		if (wrapMustache) {
			ast = {
				type: 'MustacheTag',
				expression: exprBlock,
				...this.createLocation()
			};
		}
		return ast;
	}
	parseCss(css: string) {
		css = css.trim();
		let cssAst = parseCss(css, {
			positions: true,
			offset: 0,
		});
		cssAst = JSON.parse(JSON.stringify(cssAst));
		walk(cssAst, {
			enter(node: any) {
				if (node.loc) {
					node.start = node.loc.start.offset;
					node.end = node.loc.end.offset;
					delete node.loc;
				}
			}
		});
		const ast = {
			type: 'Style' as const,
			attributes: [],
			children: cssAst.children,
			content: {
				styles: css,
				...this.createLocation(false, { start: 0, end: css.length }),
			},
			...this.createLocation(false, { start: 0, end: css.length }),
		};
		return ast;
	}
}

export function parseVisualSchema(schema: VisualSchema & { tag?: string }, options: ParserOptions = {}): Ast {
	const { customElement } = options;
	const customTag = customElement && schema.tag;
	const parser = new VisualSchemaParser(schema, customTag);
	return {
		html: parser.getHtml(),
		css: parser.getCss(),
		instance: parser.getInstance(),
		module: parser.getModule(),
	};
}
