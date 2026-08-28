export interface XmlNode {
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: XmlNode[];
  text: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 200_000;

function decodeEntity(value: string): string {
  return value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const codePoint = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error('SVN_XML_INVALID_ENTITY');
    }
    return String.fromCodePoint(codePoint);
  }).replace(/&[^;\s]{1,64};/g, () => { throw new Error('SVN_XML_UNKNOWN_ENTITY'); });
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let remaining = source.trim();
  while (remaining.length > 0) {
    const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')\s*/.exec(remaining);
    if (!match) throw new Error('SVN_XML_INVALID_ATTRIBUTE');
    if (Object.hasOwn(attributes, match[1])) throw new Error('SVN_XML_DUPLICATE_ATTRIBUTE');
    attributes[match[1]] = decodeEntity(match[2].slice(1, -1));
    remaining = remaining.slice(match[0].length);
  }
  return attributes;
}

export function parseSvnXml(xml: string, maxBytes = MAX_XML_BYTES): XmlNode {
  if (Buffer.byteLength(xml, 'utf8') > Math.min(maxBytes, MAX_XML_BYTES)) throw new Error('SVN_XML_TOO_LARGE');
  const normalized = xml.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(normalized)) throw new Error('SVN_XML_DTD_FORBIDDEN');
  if (/<![^-]/.test(normalized)) throw new Error('SVN_XML_DECLARATION_FORBIDDEN');

  const document: XmlNode = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlNode[] = [document];
  let nodes = 0;
  let cursor = 0;
  const tokenPattern = /<\?xml\s+[^?]*\?>|<!--[\s\S]*?-->|<\/[^>]+>|<[^>]+>/g;
  for (const match of normalized.matchAll(tokenPattern)) {
    const offset = match.index ?? 0;
    const text = normalized.slice(cursor, offset);
    if (text) stack.at(-1)!.text += decodeEntity(text);
    const token = match[0];
    cursor = offset + token.length;
    if (token.startsWith('<?xml') || token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim();
      if (!NAME.test(name) || stack.length === 1 || stack.at(-1)!.name !== name) throw new Error('SVN_XML_MISMATCHED_TAG');
      stack.pop();
      continue;
    }
    const selfClosing = token.endsWith('/>');
    const inside = token.slice(1, selfClosing ? -2 : -1).trim();
    const separator = inside.search(/\s/);
    const name = separator < 0 ? inside : inside.slice(0, separator);
    if (!NAME.test(name)) throw new Error('SVN_XML_INVALID_TAG');
    const attributes = parseAttributes(separator < 0 ? '' : inside.slice(separator + 1));
    const node: XmlNode = { name, attributes, children: [], text: '' };
    stack.at(-1)!.children.push(node);
    nodes += 1;
    if (nodes > MAX_NODES) throw new Error('SVN_XML_TOO_MANY_NODES');
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > MAX_DEPTH + 1) throw new Error('SVN_XML_TOO_DEEP');
    }
  }
  const trailing = normalized.slice(cursor);
  if (trailing.trim()) stack.at(-1)!.text += decodeEntity(trailing);
  if (stack.length !== 1 || document.children.length !== 1) throw new Error('SVN_XML_INVALID_DOCUMENT');
  return document.children[0];
}

export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((candidate) => candidate.name === name);
}

export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((candidate) => candidate.name === name);
}

export function textOf(node: XmlNode | undefined): string | undefined {
  return node?.text.trim();
}
