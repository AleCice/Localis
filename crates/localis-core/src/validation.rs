use crate::error::{CoreError, Result};

pub const NAME_MAX: usize = 120;
pub const DESCRIPTION_MAX: usize = 2000;

/// Trims and validates a project name.
pub fn validate_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(CoreError::validation("name", "Inserisci un nome."));
    }
    if name.chars().count() > NAME_MAX {
        return Err(CoreError::validation(
            "name",
            "Il nome può avere al massimo 120 caratteri.",
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(CoreError::validation(
            "name",
            "Il nome contiene caratteri non validi.",
        ));
    }
    Ok(name.to_owned())
}

/// Trims and validates an optional description; empty becomes `None`.
pub fn validate_description(raw: Option<&str>) -> Result<Option<String>> {
    let Some(description) = raw.map(str::trim).filter(|d| !d.is_empty()) else {
        return Ok(None);
    };
    if description.chars().count() > DESCRIPTION_MAX {
        return Err(CoreError::validation(
            "description",
            "La descrizione può avere al massimo 2000 caratteri.",
        ));
    }
    if description
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(CoreError::validation(
            "description",
            "La descrizione contiene caratteri non validi.",
        ));
    }
    Ok(Some(description.to_owned()))
}

/// Case-insensitive comparison key for names (Unicode-aware, unlike SQLite NOCASE).
pub(crate) fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name_err(raw: &str) -> String {
        match validate_name(raw) {
            Err(CoreError::Validation { field, message }) => {
                assert_eq!(field, "name");
                message
            }
            other => panic!("expected validation error, got {other:?}"),
        }
    }

    #[test]
    fn name_is_trimmed() {
        assert_eq!(validate_name("  Tesi  ").unwrap(), "Tesi");
    }

    #[test]
    fn empty_and_whitespace_names_rejected() {
        assert_eq!(name_err(""), "Inserisci un nome.");
        assert_eq!(name_err("   \t\n "), "Inserisci un nome.");
    }

    #[test]
    fn name_length_counts_unicode_scalars() {
        assert!(validate_name(&"è".repeat(NAME_MAX)).is_ok());
        assert_eq!(
            name_err(&"è".repeat(NAME_MAX + 1)),
            "Il nome può avere al massimo 120 caratteri."
        );
        // Surrounding spaces do not count.
        assert!(validate_name(&format!("  {}  ", "a".repeat(NAME_MAX))).is_ok());
    }

    #[test]
    fn control_chars_in_name_rejected() {
        for raw in ["a\nb", "a\u{0}b", "a\tb", "a\u{7f}b", "a\u{9b}b"] {
            assert_eq!(name_err(raw), "Il nome contiene caratteri non validi.");
        }
    }

    #[test]
    fn description_rules() {
        assert_eq!(validate_description(None).unwrap(), None);
        assert_eq!(validate_description(Some("")).unwrap(), None);
        assert_eq!(validate_description(Some("  \n ")).unwrap(), None);
        assert_eq!(
            validate_description(Some(" riga 1\n\triga 2\r\n ")).unwrap(),
            Some("riga 1\n\triga 2".to_owned())
        );
        assert!(validate_description(Some(&"x".repeat(DESCRIPTION_MAX))).is_ok());
        assert!(matches!(
            validate_description(Some(&"x".repeat(DESCRIPTION_MAX + 1))),
            Err(CoreError::Validation { field: "description", .. })
        ));
        assert!(matches!(
            validate_description(Some("a\u{0}b")),
            Err(CoreError::Validation { field: "description", .. })
        ));
    }

    #[test]
    fn name_key_is_unicode_case_insensitive() {
        assert_eq!(name_key(" Èlite "), name_key("èlite"));
        assert_eq!(name_key("STRASSE"), name_key("strasse"));
    }
}
