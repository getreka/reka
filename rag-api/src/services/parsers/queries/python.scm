; ============================================================
; Python tree-sitter queries
; Grammar: tree-sitter-python
; ============================================================

; ------------------------------------------------------------
; Imports
; ------------------------------------------------------------

; import X
; import X.Y.Z
(import_statement
  name: (dotted_name) @import.name) @import.statement

; import X as Y
(import_statement
  (aliased_import
    name: (dotted_name) @import.name
    alias: (identifier) @import.alias)) @import.statement

; from X import Y
(import_from_statement
  module_name: (dotted_name) @import.source
  name: (dotted_name) @import.name) @import.statement

; from X import Y, Z
(import_from_statement
  module_name: (dotted_name) @import.source
  name: (dotted_name) @import.name) @import.statement

; from X import Y as Z
(import_from_statement
  module_name: (dotted_name) @import.source
  (aliased_import
    name: (dotted_name) @import.name)) @import.statement

; from X import *
(import_from_statement
  module_name: (dotted_name) @import.source
  (wildcard_import)) @import.statement

; from . import X  (relative import)
(import_from_statement
  module_name: (relative_import) @import.source
  name: (dotted_name) @import.name) @import.statement

; ------------------------------------------------------------
; Function definitions
; ------------------------------------------------------------

; def foo(...)
(function_definition
  name: (identifier) @definition.name) @definition.node

; ------------------------------------------------------------
; Class definitions
; ------------------------------------------------------------

; class Foo:
(class_definition
  name: (identifier) @definition.name) @definition.node

; class Foo(Bar, Baz):
(class_definition
  name: (identifier) @definition.name
  superclasses: (argument_list
    (identifier) @extends.name)) @definition.node

; class Foo(module.Base):
(class_definition
  name: (identifier) @definition.name
  superclasses: (argument_list
    (attribute
      object: (identifier) @extends.name))) @definition.node

; ------------------------------------------------------------
; Decorators
; ------------------------------------------------------------

; @decorator
(decorated_definition
  (decorator
    (identifier) @import.name)) @definition.node

; @module.decorator
(decorated_definition
  (decorator
    (attribute
      object: (identifier) @import.name))) @definition.node

; ------------------------------------------------------------
; Function calls (call graph)
; ------------------------------------------------------------

; foo()
(call
  function: (identifier) @call.function) @call.node

; obj.method()
(call
  function: (attribute
    attribute: (identifier) @call.function)) @call.node
