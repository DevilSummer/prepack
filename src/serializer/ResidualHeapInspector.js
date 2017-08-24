/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import { Realm } from "../realm.js";
import type { Descriptor } from "../types.js";
import { IsArray } from "../methods/index.js";
import {
  SymbolValue,
  AbstractValue,
  FunctionValue,
  ECMAScriptSourceFunctionValue,
  NumberValue,
  Value,
  ObjectValue,
  PrimitiveValue,
  UndefinedValue,
} from "../values/index.js";
import invariant from "../invariant.js";
import { Logger } from "./logger.js";

export class ResidualHeapInspector {
  constructor(realm: Realm, logger: Logger) {
    this.realm = realm;
    this.logger = logger;
    this.ignoredProperties = new Map();
  }

  realm: Realm;
  logger: Logger;
  ignoredProperties: Map<ObjectValue, Set<string>>;

  static isLeaf(val: Value): boolean {
    if (val instanceof SymbolValue) {
      return false;
    }

    if (val instanceof AbstractValue && val.hasIdentifier()) {
      return true;
    }

    if (val.isIntrinsic()) {
      return false;
    }

    return val instanceof PrimitiveValue;
  }

  // Object properties which have the default value can be ignored by the serializer.
  canIgnoreProperty(val: ObjectValue, key: string) {
    let set = this.ignoredProperties.get(val);
    if (!set) {
      this.ignoredProperties.set(val, (set = this._getIgnoredProperties(val)));
    }
    return set.has(key);
  }

  _getIgnoredProperties(val: ObjectValue) {
    let set = new Set();
    for (let [key, propertyBinding] of val.properties) {
      invariant(propertyBinding);
      let desc = propertyBinding.descriptor;
      if (desc === undefined) continue; //deleted
      if (this._canIgnoreProperty(val, key, desc)) set.add(key);
    }
    return set;
  }

  _canIgnoreProperty(val: ObjectValue, key: string, desc: Descriptor) {
    if (IsArray(this.realm, val)) {
      if (key === "length" && desc.writable && !desc.enumerable && !desc.configurable) {
        // length property has the correct descriptor values
        return true;
      }
    } else if (val instanceof FunctionValue) {
      if (key === "length") {
        if (desc.value === undefined) {
          this.logger.logError(val, "Functions with length accessor properties are not supported in residual heap.");
          // Rationale: .bind() would call the accessor, which might throw, mutate state, or do whatever...
        }
        // length property will be inferred already by the amount of parameters
        return !desc.writable && !desc.enumerable && desc.configurable && val.hasDefaultLength();
      }

      if (key === "name") {
        // TODO #474: Make sure that we retain original function names. Or set name property.
        // Or ensure that nothing references the name property.
        // NOTE: with some old runtimes notably JSC, function names are not configurable
        // For now don't ignore the property if it is different from the function name.
        // I.e. if it was set explicitly in the code, retain it.
        if (
          desc.value !== undefined &&
          !this.realm.isCompatibleWith(this.realm.MOBILE_JSC_VERSION) &&
          (desc.value instanceof AbstractValue ||
            (val.__originalName && val.__originalName !== "" && desc.value.value !== val.__originalName))
        )
          return false;
        return true;
      }

      // Properties `caller` and `arguments` are added to normal functions in non-strict mode to prevent TypeErrors.
      // Because they are autogenerated, they should be ignored.
      if (key === "arguments" || key === "caller") {
        invariant(val instanceof ECMAScriptSourceFunctionValue);
        if (
          !val.$Strict &&
          desc.writable &&
          !desc.enumerable &&
          desc.configurable &&
          desc.value instanceof UndefinedValue &&
          val.$FunctionKind === "normal"
        )
          return true;
      }

      // ignore the `prototype` property when it's the right one
      if (key === "prototype") {
        if (
          !desc.configurable &&
          !desc.enumerable &&
          desc.writable &&
          desc.value instanceof ObjectValue &&
          desc.value.originalConstructor === val
        ) {
          return true;
        }
      }
    } else {
      let kind = val.getKind();
      switch (kind) {
        case "RegExp":
          if (key === "lastIndex" && desc.writable && !desc.enumerable && !desc.configurable) {
            // length property has the correct descriptor values
            let v = desc.value;
            return v instanceof NumberValue && v.value === 0;
          }
          break;
        default:
          break;
      }
    }

    if (key === "constructor") {
      if (desc.configurable && !desc.enumerable && desc.writable && desc.value === val.originalConstructor) return true;
    }

    return false;
  }

  static getPropertyValue(val: ObjectValue, name: string): void | Value {
    let prototypeBinding = val.properties.get(name);
    if (prototypeBinding === undefined) return undefined;
    let prototypeDesc = prototypeBinding.descriptor;
    if (prototypeDesc === undefined) return undefined;
    return prototypeDesc.value;
  }

  isDefaultPrototype(prototype: ObjectValue): boolean {
    if (
      prototype.symbols.size !== 0 ||
      prototype.$Prototype !== this.realm.intrinsics.ObjectPrototype ||
      !prototype.getExtensible()
    )
      return false;
    let foundConstructor = false;
    for (let name of prototype.properties.keys())
      if (
        name === "constructor" &&
        ResidualHeapInspector.getPropertyValue(prototype, name) === prototype.originalConstructor
      )
        foundConstructor = true;
      else return false;
    return foundConstructor;
  }
}