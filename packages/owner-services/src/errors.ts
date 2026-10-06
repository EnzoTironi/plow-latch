export class OwnerServiceError extends Error {
  constructor(readonly code:
    | "invalid_input"
    | "unknown_channel"
    | "owner_approval_required"
    | "wrong_owner"
    | "closed"
    | "close_failed"
    | "cancelled"
    | "invalid_settings"
    | "plaintext_credentials_present"
    | "secret_store_locked"
    | "unsafe_settings_path") {
    super(code);
    this.name = "OwnerServiceError";
  }
}
