// Document path rules, shared by the web CRUD path and CI publication so the two cannot drift apart.
// Pure, so the rules are unit-testable without a Durable Object.

export const MAX_DOCUMENT_PATH_LENGTH = 1024;

// Validate a document path before using it as a storage key.
export function validateDocumentPath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Document path is required.");
  }
  if (path.length > MAX_DOCUMENT_PATH_LENGTH) {
    throw new Error(`Document path is too long (max ${MAX_DOCUMENT_PATH_LENGTH} characters).`);
  }
  if (path.startsWith("/")) {
    throw new Error("Document path must be relative (no leading '/').");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Document path must not contain control characters.");
  }
  for (let segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("Document path must not contain empty, '.', or '..' segments.");
    }
  }
}

// Whether a path is usable, for callers that reject entries rather than throwing.
export function isValidDocumentPath(path: string): boolean {
  try {
    validateDocumentPath(path);
    return true;
  } catch {
    return false;
  }
}

// Last path segment; document names derive from paths.
export function baseName(path: string): string {
  let i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}
