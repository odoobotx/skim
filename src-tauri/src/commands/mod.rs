pub mod accounts;
pub mod ai;
pub mod compose;
pub mod invites;
pub mod mail;
pub mod search;
pub mod settings;

/// External apps do not inherit Skim's redirected filesystem view on Windows.
pub(super) fn file_for_external_app(
    path: impl AsRef<std::path::Path>,
) -> std::io::Result<std::path::PathBuf> {
    let path = dunce::canonicalize(path)?;
    if !path.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "The attachment path is not a file",
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::file_for_external_app;
    use std::fs;

    #[test]
    fn external_file_paths_resolve_aliases_and_preserve_special_names() {
        let dir = std::env::temp_dir().join(format!("skim-open-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let source = dir.join("Report #2 résumé.pdf");
        fs::write(&source, b"synthetic attachment").unwrap();
        let resolved = file_for_external_app(dir.join(".").join("Report #2 résumé.pdf")).unwrap();
        assert!(resolved.is_absolute());
        assert_eq!(fs::read(&resolved).unwrap(), b"synthetic attachment");
        assert_eq!(resolved.file_name(), source.file_name());
        #[cfg(windows)]
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
        #[cfg(unix)]
        {
            let alias = dir.join("alias.pdf");
            std::os::unix::fs::symlink(&source, &alias).unwrap();
            assert_eq!(file_for_external_app(&alias).unwrap(), resolved);
            fs::remove_file(alias).unwrap();
        }
        assert!(file_for_external_app(&dir).is_err());
        fs::remove_file(&source).unwrap();
        assert_eq!(
            file_for_external_app(&source).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        fs::remove_dir(dir).unwrap();
    }
}
