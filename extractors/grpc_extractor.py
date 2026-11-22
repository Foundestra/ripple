#!/usr/bin/env python3
"""Extract gRPC/Protobuf imports, stub usage and service registrations from a Java or Python file.

Requires: tree-sitter>=0.23, tree-sitter-java, tree-sitter-python.

Usage:
    python grpc_extractor.py --file path/to/File.java --language java
    python grpc_extractor.py --file path/to/server.py --language python

Prints JSON with schema_version "2.0" to stdout.
"""
import argparse
import json
import sys
from pathlib import Path

import tree_sitter
import tree_sitter_java
import tree_sitter_python

SCHEMA_VERSION = "2.0"
QUERY_DIR = Path(__file__).resolve().parent / "queries"
LANGUAGES = {
    "java": (tree_sitter_java.language, QUERY_DIR / "java_grpc.scm"),
    "python": (tree_sitter_python.language, QUERY_DIR / "python_grpc.scm"),
}


def _node_text(source, node):
    return source[node.start_byte:node.end_byte].decode("utf-8", "replace")


def _import_path(language, fields):
    if language == "java":
        return fields.get("import.path")
    module = fields.get("import.module")
    symbol = fields.get("import.symbol")
    if module and symbol:
        return module + "." + symbol
    return module


def extract(file_path, language):
    if language not in LANGUAGES:
        raise ValueError("unsupported language: " + str(language))
    language_fn, query_path = LANGUAGES[language]
    lang = tree_sitter.Language(language_fn())
    parser = tree_sitter.Parser(lang)

    source = Path(file_path).read_bytes()
    tree = parser.parse(source)
    query = tree_sitter.Query(lang, query_path.read_text(encoding="utf-8"))

    extractions = []
    for _pattern_index, captures in tree_sitter.QueryCursor(query).matches(tree.root_node):
        kind = None
        line = None
        fields = {}
        for name, nodes in captures.items():
            if not nodes:
                continue
            node = nodes[0]
            if name.startswith("grpc."):
                kind = name[len("grpc."):]
                line = node.start_point[0] + 1
            else:
                fields[name] = _node_text(source, node)
        if kind is None:
            continue
        record = {
            "kind": kind,
            "line": line,
            "symbols": fields,
        }
        import_path = _import_path(language, fields) if kind == "proto_import" else None
        if import_path:
            record["import_path"] = import_path
        extractions.append(record)

    return {
        "schema_version": SCHEMA_VERSION,
        "file": str(file_path),
        "language": language,
        "extractions": extractions,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Extract gRPC/Protobuf references with Tree-sitter.")
    parser.add_argument("--file", required=True, help="path to the source file")
    parser.add_argument("--language", required=True, choices=sorted(LANGUAGES))
    args = parser.parse_args(argv)
    result = extract(args.file, args.language)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
