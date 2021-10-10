#!/usr/bin/env node
/**
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


import getStdin from 'get-stdin';
import * as chromeTypes from '../types/chrome.js';
import { RenderBuffer } from './lib/buffer.js';
import { isValidToken } from './lib/js-internals.js';
import * as traverse from './lib/traverse.js';
import { last } from './lib/traverse.js';
import { buildNamespaceAwareMarkdownRewrite } from './lib/comment.js';
import * as overrideApi from './override/index.js';
import * as fs from 'fs';


/** @type {chromeTypes.ProcessedAPIData} */
const o = JSON.parse(await getStdin());


const context = new traverse.TraverseContext((spec, id) => {
  const visible = overrideApi.isVisible(spec, id);
  return visible;
});


const commentRewriter = buildNamespaceAwareMarkdownRewrite(Object.keys(o.api));


const buf = new RenderBuffer();
buf.start('declare namespace chrome {');

const entries = Object.entries(o.api);
entries.sort(([a], [b]) => a.localeCompare(b));
entries.forEach(([_, namespace]) => {
  const namespaceBuffer = renderNamespace(namespace);
  if (namespaceBuffer) {
    buf.append(namespaceBuffer);
  }
});

buf.end('}');
buf.line();


const preambleFile = new URL('../content/preamble.d.ts', import.meta.url);
const preambleContent = fs.readFileSync(preambleFile);

process.stdout.write(preambleContent);
process.stdout.write(`\n\n// Generated on ${new Date}\n\n\n`);
process.stdout.write(buf.render());



/**
 * @param {chromeTypes.NamespaceSpec} namespace
 */
function renderNamespace(namespace) {
  if (namespace.nodoc) {
    return null;
  }

  const content = renderInnerNamespace(namespace);
  if (content.isEmpty) {
    return null;
  }

  const buf = new RenderBuffer();

  buf.line();
  buf.append(renderComment(namespace, `api:${namespace.namespace}`));
  buf.line();

  const { namespace: name } = namespace;
  if (isValidToken(name)) {
    buf.start(`export namespace ${name} {`);
    buf.append(content);
    buf.end('}');
  } else {
    // Allow keywords as namespace names by declaring and then re-exporting.
    // This only matters for `api:debugger`.
    buf.start(`namespace _${name} {`);
    buf.append(content);
    buf.end('}');
    buf.line(`export {_${name} as ${name}};`)
  }

  return buf;
}


/**
 * @param {chromeTypes.NamespaceSpec} namespace
 */
function renderInnerNamespace(namespace) {
  const buf = new RenderBuffer();

  const toplevel = `api:${namespace.namespace}`;

  // Render top-level types. These are either interfaces or types (probably enum or choice).
  context.forEach(namespace.types, toplevel, (spec, id) => {
    const name = last(id);

    // HACK: We get a type starting with a number at one point, but it's only used for the manifest.
    // It's invalid, and we can't re-export this anyway.
    if (!isValidToken(name)) {
      return;
    }

    buf.line();

    buf.append(renderComment(spec, id));

    if (spec.type === 'object') {
      // This is an interface.
      buf.line('export ')
      buf.append(renderObjectAsType(spec, id));
    } else {
      // This is probably an enum, but just render it as a generic type.
      buf.line(`export type ${name} = ${renderType(spec, id)};`);
    }
  });

  // Render top-level properties. These are `const` or in one case, `let`.
  const properties = context.propertiesFor(namespace, toplevel);
  for (const id in properties) {
    const spec = properties[id];
    buf.line();
    const name = last(id);
    const decl = spec.optional ? 'let' : 'const';

    buf.append(renderComment(spec, id));
    buf.line(`export ${decl} ${name}: ${renderType(spec, id)};`);
  }

  // Render top-level functions.
  context.forEach(namespace.functions, toplevel, (spec, id) => {
    buf.append(renderTopFunction(spec, id, true));
  });

  return buf;
}


/**
 * @param {chromeTypes.TypeSpec} prop
 * @param {string} id
 */
function renderObjectAsType(prop, id) {
  const name = last(id);

  const buf = new RenderBuffer();
  buf.start('{');

  // HACK: If this has the 'instanceType' property, then this is really a class that can be be
  // constructed for declarative events. It takes "itself", in that, it can be constructed
  // with a number of properties which get cloned onto the real object.
  let mode = 'interface';
  if (prop.properties?.['instanceType']) {
    mode = 'class';
    buf.line(`constructor(arg: Omit<${name}, 'instanceType'>);`);
  }

  let needsGap = false;

  const properties = context.propertiesFor(prop, id);
  for (const childId in properties) {
    const spec = properties[childId];

    const commentBuffer = renderComment(spec, childId);
    if (!commentBuffer.isEmpty) {
      buf.line();
      buf.append(commentBuffer);
      needsGap = true;
    } else if (needsGap) {
      buf.line();
      needsGap = false;
    }

    const opt = spec.optional ? '?' : '';
    const name = last(childId);
    buf.line(`${name}${opt}: ${renderType(spec, childId)};`);
  }

  context.forEach(prop.functions, id, (spec, id) => {
    buf.append(renderTopFunction(spec, id, false));
  });

  buf.end('}');

  const templates = overrideApi.objectTemplatesFor(id);
  const templatePart = templates ? `<${templates}>` : '';

  return `${mode} ${name}${templatePart} ${buf.render()}`;
}


/**
 * Renders a top-level function as a top-level part of a namespace or an interface type. This looks
 * different to a property with the _type_ of a function (e.g., "foo: () => void").
 *
 * @param {chromeTypes.TypeSpec} spec
 * @param {string} id
 * @param {boolean} exportFunction true if in namespace, false if within class
 */
function renderTopFunction(spec, id, exportFunction = false) {
  if (!spec.name) {
    throw new Error(`cannot render unnamed function: ${JSON.stringify(spec)}`);
  }

  const buf = new RenderBuffer();

  let effectiveName = spec.name;
  let prefix = '';
  if (!isValidToken(spec.name) && exportFunction) {
    prefix = 'function ';
    effectiveName = `_${effectiveName}`;
    buf.line();
    buf.line(`export {${effectiveName} as ${spec.name}};`)
  } else if (exportFunction) {
    prefix = 'export function ';
  }

  const expansions = context.expandFunctionParams(spec, id);
  for (const [returnSpec, ...params] of expansions) {
    buf.line();

    // Limit the comments here to the parameters of this specific expansion.
    const virtualSpec = {
      paramaters: params,
      returns: returnSpec,
      ...spec,
    };
    buf.append(renderComment(virtualSpec, id));

    const suffix = `: ${renderType(returnSpec, `${id}.return`)};`
    buf.line(`${prefix}${effectiveName}(`);

    if (params.length === 0) {
      buf.append(`)${suffix}`);
      continue;
    }

    buf.start('');
    params.forEach((param, i) => {
      const name = param.name || `_${i}`;
      const effectiveName = isValidToken(name) ? name : `_${name}`;

      const opt = param.optional ? '?' : '';
      buf.line(`${effectiveName}${opt}: ${renderType(param, `${id}.${name}`)},`);
    });
    buf.end(')');
    buf.append(`${suffix}`);
  }

  return buf;
}


/**
 * @param {chromeTypes.TypeSpec|undefined} spec
 * @param {string} id
 * @param {boolean} ambig whether this is in an ambigious context (e.g., "X[]")
 * @return {string}
 */
function renderType(spec, id, ambig = false) {
  spec = spec || { type: 'void' };

  // Potentially completely override the spec. Used for template magic in Event.
  spec = overrideApi.typeOverride(spec, id) ?? spec;

  // This should probably never happen. We could instead return `void`.
  if (spec.nodoc) {
    throw new Error(`render nodoc type: ${JSON.stringify(spec)}`);
  }

  // This is like $ref, but seems to win.
  if (spec.isInstanceOf) {
    return spec.isInstanceOf;
  }

  /** @type {(s: string) => string} */
  const maybeWrapAmbig = ambig ? (s) => `(${s})` : (s) => s;

  if (spec.enum) {
    if (!['string', 'integer'].includes(spec.type ?? '') || spec.enum.length === 0) {
      throw new Error(`invalid enum: ${spec.type} / ${JSON.stringify(spec.enum)}`);
    }

    /** @type {string[]|number[]} */
    let primitiveOnly;
    if (typeof spec.enum[0] === 'object') {
      // TODO(samthor): We could create virtual fake types for this so the comments live on.
      const pairs = /** @type {{name: string}[]} */ (spec.enum);
      primitiveOnly = pairs.map(({name}) => name);
    } else {
      primitiveOnly = /** @type {string[]|number[]} */ (spec.enum);
    }

    return maybeWrapAmbig(primitiveOnly.map((x) => JSON.stringify(x)).join(' | '));
  }

  if (spec.choices) {
    if (spec.choices.length === 0) {
      throw new Error(`zero choices`);
    }
    return maybeWrapAmbig(spec.choices.map((choice, i) => {
      const childId = `${id}._${i}`;
      return renderType(choice, childId);
    }).join(' | '));
  }

  if (spec.type === 'array') {
    // HACK: Some array types are missing items, just assume it's a number.
    const { items = { type: 'number' } } = spec;

    const childId = `${id}._`;
    const inner = renderType(items, childId, true);

    // There's a maximum number of items here. Render tuples from min -> max.
    if (spec.maxItems) {
      /** @type {string[]} */
      const parts = [];

      for (let i = spec.minItems ?? 0; i <= spec.maxItems; ++i) {
        parts.push(`[${new Array(i).fill(inner).join(', ')}]`);
      }
      return parts.length === 1 ? parts[0] : maybeWrapAmbig(parts.join(' | '));
    }

    const arr = `${inner}[]`;

    // This has a minimum item count, but not a maximum.
    if (spec.minItems) {
      const r = new Array(spec.minItems).fill(inner);
      return maybeWrapAmbig(`[${r.join(',')}, ...${arr}]`);
    }

    // This is an actually boring array.
    return arr;
  }

  if (spec.type === 'object') {
    const additionalPropertiesPart = spec.additionalProperties ? 
      `[name: string]: ${renderType(spec.additionalProperties, id)}` :
      '';

    const props = context.propertiesFor(spec, id);

    // If this object only has additional properties (it's just a dict), then return early.
    if (!Object.keys(props).length) {
      return `{${additionalPropertiesPart}}`;
    }

    const buf = new RenderBuffer();
    buf.start('{');

    let needsGap = false;
    if (additionalPropertiesPart) {
      needsGap = true;
      buf.line(additionalPropertiesPart + ',');
    }

    for (const childId in props) {
      const prop = props[childId];
  
      const commentBuffer = renderComment(prop, childId);
      if (!commentBuffer.isEmpty) {
        buf.line();
        buf.append(commentBuffer);
        needsGap = true;
      } else if (needsGap) {
        buf.line();
        needsGap = false;
      }

      const name = last(childId);
      const opt = prop.optional ? '?' : '';
      buf.line(`${name}${opt}: ${renderType(prop, `${id}.${name}`)},`);
    }

    buf.end('}');
    return buf.render();
  }

  if (spec.$ref) {
    // HACK: This is a special-case: `api:storage.sync` and friends have properties that are
    // combined with a $ref instance. We treat this as a union (the only case in the codebase).
    if (spec.properties && Object.keys(spec.properties).length) {
      const { properties, ...rest } = spec;
      return `${renderType(rest, id)} & ${renderType({ properties, type: 'object' }, `${id}.!`)}`;
    }

    // This (probably) has a template type.
    if (spec.value) {
      if (!Array.isArray(spec.value)) {
        throw new Error(`unexpected template type for $ref: ${JSON.stringify(spec.value)}`);
      }

      // HACK: We see ['randomString', { type } ] in the codebase, but occasionally give extra
      // types in our rendering to demonstrate further template types.
      if (spec.value.length > 1) {
        const templates = /** @type {chromeTypes.TypeSpec[]} */ (spec.value.slice(1));
        const inner = templates.map((spec, i) => {
          const childId = `${id}.@${i}`;
          return renderType(spec, childId);
        });
        return `${spec.$ref}<${inner.join(', ')}>`;
      }

      // nb. The single variable name appears on instances of `api:storage.StorageArea`, but doesn't
      // seem to mean anything. Ignore for now.
    }

    return spec.$ref;
  }

  if (spec.value) {
    return JSON.stringify(spec.value);
  }

  // Render inline functions. Catch where no type is specified but we have parameters.
  if (spec.type === 'function' || (!spec.type && spec.parameters)) {
    const buf = new RenderBuffer();

    // Filter nodoc parameters, which appear occasionally. They are effectively optional params
    // so just remove them here.
    const params = (spec.parameters ?? []).filter(({nodoc}) => !nodoc);
    if (params.length) {
      buf.start('(');
      let needsGap = false;

      // HACK: Sometimes we find early optional parameters in inline functions. This isn't valid,
      // so just disallow it anyway, and only allow tail optionals.
      let lastOptional = params.length;
      while (params[lastOptional - 1]?.optional) {
        --lastOptional;
      }

      params.forEach((param, i) => {
        const name = param.name || `_${i}`;
        const childId = `${id}.${name}`;

        const commentBuffer = renderComment(param, childId);
        if (!commentBuffer.isEmpty) {
          buf.line();
          buf.append(commentBuffer);
          needsGap = true;
        } else if (needsGap) {
          buf.line();
          needsGap = false;
        }

        const opt = i >= lastOptional && param.optional ? '?' : '';
        buf.line(`${param.name}${opt}: ${renderType(param, childId)},`);
      });

      buf.end(')');
    } else {
      buf.append('()');
    }

    // Inline functions cannot have dual Promise/return behavior.
    if (spec.returns_async) {
      throw new Error(`got inline returns_async on function: ${JSON.stringify(spec)}`);
    }

    // We give this an internal ID of "return", which is a keyword, to match feature definitions
    // and availability version-over-version.
    buf.append(` => ${renderType(spec.returns, `${id}.return`)}`);
    return buf.render();
  }

  switch (spec.type) {
    case 'int64':
    case 'integer':
    case 'number':
    case 'double':
      return 'number';

    case 'binary':
      return 'ArrayBuffer';

    case 'any':
      return overrideApi.replaceAnyWith(id) ?? 'any';

    case 'boolean':
    case 'string':
    case 'void':
    case 'undefined':
      return spec.type;
  }

  throw new Error(`unsupported type: ${JSON.stringify(spec)}`);
}


/**
 * @param {chromeTypes.TypeSpec} spec
 * @param {string} id
 */
function renderComment(spec, id) {
  /** @type {{name: string, value?: string}[]} */
  const tags = [];

  (spec.parameters ?? []).forEach((param, i) => {
    let value = `${param.name ?? `_${i}`}`;
    if (param.description) {
      value += ` ${param.description}`;
    }
    tags.push({name: 'param', value});
  });

  if (spec.returns?.description) {
    tags.push({name: 'returns', value: spec.returns.description});
  }

  if (spec.deprecated !== undefined) {
    const value = spec.deprecated ?? '';
    tags.push({name: 'deprecated', value});
  }

  // This adds `@chrome-enum "NAME" description` to the comment.
  // We don't have a great way to document these otherwise.
  if (spec.enum) {
    for (const e of spec.enum) {
      if (typeof e === 'object' && e.description) {
        tags.push({name: 'chrome-enum', value: `${JSON.stringify(e.name)} ${e.description}`});
      }
    }
  }

  const buf = new RenderBuffer();

  let description = spec.description || '';
  if (description.toLocaleLowerCase() === 'none') {
    description = '';
  }

  // Nothing to render, just return an empty buffer.
  if (!description && !tags.length) {
    return buf;
  }

  const namespaceName = traverse.namespaceNameFromId(id);

  // Rewrite the description.
  if (description) {
    const update = commentRewriter(namespaceName, description);
    description = update;
  }

  // Rewrite any tags with values.
  for (const tag of tags) {
    if (tag.value) {
      const update = commentRewriter(namespaceName, tag.value);
      tag.value = update;
    }
  }

  buf.comment(description, tags);
  return buf;
}