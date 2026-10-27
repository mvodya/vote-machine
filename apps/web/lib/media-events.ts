// Report status codes without sending private file paths or link keys
export function reportMediaFailure(status: number, code?: number) {
  window.dispatchEvent(
    new CustomEvent('vm-media-failure', {
      detail: {status, code, at: Date.now()},
    }),
  );
}
