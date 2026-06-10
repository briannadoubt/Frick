//! `frick scaffold object|stream|projection <Name>`
//! (ported from `apps/cli/src/commands/scaffold.ts`).
//!
//! Objects/streams: PascalCase names, spliced into the `objects: [` / `streams:
//! [` array literal in `src/schema.ts`, IDs allocated from `// frick:<sec>:id N`
//! markers. Projections: kebab-case names, a new `src/projections/<name>.ts`
//! plus import/register lines in `src/server.ts`. Duplicate ⇒ refusal (exit 3).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::argv::ParsedArgs;
use crate::errors::{CliError, EXIT_OK};
use crate::output::Output;

const PROJECTION_IMPORTS_MARKER: &str = "// frick:projections:imports";
const PROJECTION_REGISTER_MARKER: &str = "// frick:projections:register";

/// `scaffoldCommand`.
pub fn scaffold_command(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    match parsed.positional(0) {
        Some("object") => scaffold_object(parsed, out),
        Some("stream") => scaffold_stream(parsed, out),
        Some("projection") => scaffold_projection(parsed, out),
        other => Err(CliError::usage_with(
            format!(
                "Unknown scaffold subcommand: {}",
                other.unwrap_or("<missing>")
            ),
            json!({ "expected": ["object", "stream", "projection"] }),
        )),
    }
}

fn resolve_directory(parsed: &ParsedArgs) -> PathBuf {
    let flag = parsed
        .flag_str("directory")
        .or_else(|| parsed.flag_str("cwd"));
    match flag {
        Some(value) if !value.is_empty() => {
            let path = Path::new(value);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(path)
            }
        }
        _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }
}

fn require_positional<'a>(
    parsed: &'a ParsedArgs,
    index: usize,
    label: &str,
) -> Result<&'a str, CliError> {
    parsed
        .positional(index)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| CliError::usage(format!("frick scaffold requires {label}")))
}

fn assert_pascal_case(name: &str, label: &str) -> Result<(), CliError> {
    let mut chars = name.chars();
    let valid = matches!(chars.next(), Some(c) if c.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_alphanumeric());
    if valid {
        Ok(())
    } else {
        Err(CliError::usage(format!(
            "{label} must be PascalCase, got {}",
            serde_json::to_string(name).unwrap_or_else(|_| format!("\"{name}\""))
        )))
    }
}

fn assert_kebab_case(name: &str, label: &str) -> Result<(), CliError> {
    let mut chars = name.chars();
    let valid = matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if valid {
        Ok(())
    } else {
        Err(CliError::usage(format!(
            "{label} must be kebab-case, got {}",
            serde_json::to_string(name).unwrap_or_else(|_| format!("\"{name}\""))
        )))
    }
}

fn read_schema_file(directory: &Path) -> Result<(PathBuf, String), CliError> {
    let path = directory.join("src").join("schema.ts");
    if !path.exists() {
        return Err(CliError::refused_with(
            format!(
                "No src/schema.ts found in {}. Run 'frick init' first.",
                directory.display()
            ),
            json!({ "path": path.to_string_lossy() }),
        ));
    }
    let body = fs::read_to_string(&path)
        .map_err(|err| CliError::failure("cli.io", format!("read failed: {err}")))?;
    Ok((path, body))
}

fn insert_after_marker(body: &str, marker: &str, insertion: &str) -> Result<String, CliError> {
    let Some(idx) = body.find(marker) else {
        return Err(CliError::refused(format!(
            "schema.ts is missing marker {marker}"
        )));
    };
    let Some(line_end) = body[idx..].find('\n').map(|rel| idx + rel) else {
        return Err(CliError::refused(format!(
            "schema.ts marker {marker} not at start of a line"
        )));
    };
    Ok(format!(
        "{}{insertion}{}",
        &body[..=line_end],
        &body[line_end + 1..]
    ))
}

fn next_numeric_id(body: &str, section_label: &str) -> i64 {
    let needle = format!("// frick:{section_label}:id ");
    let mut max_id = 0_i64;
    let mut search = body;
    while let Some(pos) = search.find(&needle) {
        let after = &search[pos + needle.len()..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if let Ok(n) = digits.parse::<i64>()
            && n > max_id
        {
            max_id = n;
        }
        search = &after[digits.len()..];
    }
    max_id + 1
}

fn object_stub(name: &str, id: i64) -> String {
    let name_lit = serde_json::to_string(name).unwrap_or_else(|_| format!("\"{name}\""));
    format!(
        "  // frick:objects:id {id} {name}\n\
  {{\n\
    id: {id},\n\
    name: {name_lit},\n\
    fields: [\n\
      {{ id: 1, name: \"displayName\", kind: \"string\", required: true }},\n\
    ],\n\
    indexes: [{{ id: 1, name: \"all\", fields: [\"displayName\"] }}],\n\
  }},\n"
    )
}

fn stream_stub(name: &str, id: i64) -> String {
    let name_lit = serde_json::to_string(name).unwrap_or_else(|_| format!("\"{name}\""));
    format!(
        "  // frick:streams:id {id} {name}\n\
  {{\n\
    id: {id},\n\
    name: {name_lit},\n\
    keyFields: [{{ id: 1, name: \"key\", kind: \"string\", required: true }}],\n\
    events: [],\n\
  }},\n"
    )
}

fn append_to_array_literal(
    body: &str,
    section_name: &str,
    insertion: &str,
) -> Result<String, CliError> {
    let header = format!("{section_name}: [");
    let Some(header_idx) = body.find(&header) else {
        return Err(CliError::refused(format!(
            "schema.ts is missing '{header}' literal"
        )));
    };
    let bytes = body.as_bytes();
    let mut depth = 0_i32;
    let mut i = header_idx + header.len() - 1; // position at the '['
    let mut closing: Option<usize> = None;
    while i < bytes.len() {
        match bytes[i] {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    closing = Some(i);
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let Some(close_idx) = closing else {
        return Err(CliError::refused(format!(
            "schema.ts '{section_name}' literal is unbalanced"
        )));
    };
    let before = &body[..close_idx];
    let after = &body[close_idx..];
    let prefix = if before.ends_with('[') { "\n" } else { "" };
    Ok(format!("{before}{prefix}{insertion}{after}"))
}

fn section_contains_name(body: &str, section_label: &str, name: &str) -> bool {
    // Mirror the TS regexp `// frick:<sec>:id \d+ <name>\b`.
    let prefix = format!("// frick:{section_label}:id ");
    let mut search = body;
    while let Some(pos) = search.find(&prefix) {
        let after = &search[pos + prefix.len()..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        let rest = &after[digits.len()..];
        if let Some(tail) = rest.strip_prefix(' ')
            && tail.starts_with(name)
        {
            // `\b` after the name: next char must not be alphanumeric/underscore.
            let next = tail[name.len()..].chars().next();
            if next.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_')) {
                return true;
            }
        }
        search = &after[digits.len()..];
    }
    false
}

fn scaffold_object(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    let name = require_positional(parsed, 1, "<Name> for the object")?.to_string();
    assert_pascal_case(&name, "object name")?;
    let directory = resolve_directory(parsed);
    let (path, body) = read_schema_file(&directory)?;
    if section_contains_name(&body, "objects", &name) {
        return Err(CliError::refused_with(
            format!("Object {name} already exists in schema.ts"),
            json!({ "path": path.to_string_lossy() }),
        ));
    }
    let id = next_numeric_id(&body, "objects");
    let next = append_to_array_literal(&body, "objects", &object_stub(&name, id))?;
    fs::write(&path, next)
        .map_err(|err| CliError::failure("cli.io", format!("write failed: {err}")))?;
    out.emit(&json!({
        "ok": true,
        "kind": "object",
        "name": name,
        "id": id,
        "path": path.to_string_lossy(),
    }));
    Ok(EXIT_OK)
}

fn scaffold_stream(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    let name = require_positional(parsed, 1, "<Name> for the stream")?.to_string();
    assert_pascal_case(&name, "stream name")?;
    let directory = resolve_directory(parsed);
    let (path, body) = read_schema_file(&directory)?;
    if section_contains_name(&body, "streams", &name) {
        return Err(CliError::refused_with(
            format!("Stream {name} already exists in schema.ts"),
            json!({ "path": path.to_string_lossy() }),
        ));
    }
    let id = next_numeric_id(&body, "streams");
    let next = append_to_array_literal(&body, "streams", &stream_stub(&name, id))?;
    fs::write(&path, next)
        .map_err(|err| CliError::failure("cli.io", format!("write failed: {err}")))?;
    out.emit(&json!({
        "ok": true,
        "kind": "stream",
        "name": name,
        "id": id,
        "path": path.to_string_lossy(),
    }));
    Ok(EXIT_OK)
}

fn to_pascal_case(kebab: &str) -> String {
    kebab
        .split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_ascii_uppercase().to_string() + chars.as_str()
            })
        })
        .collect()
}

fn projection_file(name: &str) -> String {
    let name_lit = serde_json::to_string(name).unwrap_or_else(|_| format!("\"{name}\""));
    let pascal = to_pascal_case(name);
    format!(
        "/**\n\
 * Projection scaffold for \"{name}\". Register it in src/server.ts — it is\n\
 * added to the app's `projections` array via the marker comments.\n\
 */\n\
export function create{pascal}Projection() {{\n\
  return {{\n\
    name: {name_lit},\n\
    sources: [] as const,\n\
    handler: {{\n\
      apply(_event: unknown, _ctx: unknown) {{\n\
        return {{ changes: [] as unknown[] }};\n\
      }},\n\
    }},\n\
  }};\n\
}}\n"
    )
}

fn read_server_file(directory: &Path) -> Result<(PathBuf, String), CliError> {
    let path = directory.join("src").join("server.ts");
    if !path.exists() {
        return Err(CliError::refused_with(
            format!(
                "No src/server.ts found in {}. Run 'frick init' first.",
                directory.display()
            ),
            json!({ "path": path.to_string_lossy() }),
        ));
    }
    let body = fs::read_to_string(&path)
        .map_err(|err| CliError::failure("cli.io", format!("read failed: {err}")))?;
    Ok((path, body))
}

fn scaffold_projection(parsed: &ParsedArgs, out: &mut Output) -> Result<i32, CliError> {
    let name = require_positional(parsed, 1, "<name> for the projection (kebab-case)")?.to_string();
    assert_kebab_case(&name, "projection name")?;
    let directory = resolve_directory(parsed);

    let projection_path = directory
        .join("src")
        .join("projections")
        .join(format!("{name}.ts"));
    if projection_path.exists() {
        return Err(CliError::refused_with(
            format!(
                "Projection file already exists: {}",
                projection_path.display()
            ),
            json!({ "path": projection_path.to_string_lossy() }),
        ));
    }

    let (server_path, server_body) = read_server_file(&directory)?;
    let factory_name = format!("create{}Projection", to_pascal_case(&name));
    if server_body.contains(&factory_name) {
        return Err(CliError::refused_with(
            format!("Projection {name} appears already registered in server.ts"),
            json!({ "path": server_path.to_string_lossy() }),
        ));
    }

    if let Some(parent) = projection_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| CliError::failure("cli.io", format!("mkdir failed: {err}")))?;
    }
    fs::write(&projection_path, projection_file(&name))
        .map_err(|err| CliError::failure("cli.io", format!("write failed: {err}")))?;

    let import_line = format!("import {{ {factory_name} }} from \"./projections/{name}.js\";\n");
    let register_line = format!(
        "// TODO: register {factory_name}() with your projection registry\nvoid {factory_name};\n"
    );

    let mut next_server =
        insert_after_marker(&server_body, PROJECTION_IMPORTS_MARKER, &import_line)?;
    next_server = insert_after_marker(&next_server, PROJECTION_REGISTER_MARKER, &register_line)?;
    fs::write(&server_path, next_server)
        .map_err(|err| CliError::failure("cli.io", format!("write failed: {err}")))?;

    out.emit(&json!({
        "ok": true,
        "kind": "projection",
        "name": name,
        "projectionPath": projection_path.to_string_lossy(),
        "serverPath": server_path.to_string_lossy(),
    }));
    Ok(EXIT_OK)
}
