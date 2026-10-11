export type ProcessingErrorCode =
  | 'unsupported_type'
  | 'corrupt_file'
  | 'encrypted_pdf'
  | 'too_many_pages'
  | 'empty_document'
  | 'image_too_large'
  | 'timeout'
  | 'tool_unavailable'
  | 'processing_failed';

/**
 * A document could not be processed. `message` is written for the student and is safe to show;
 * technical detail goes to the logs, never into the message.
 */
export class ProcessingError extends Error {
  constructor(
    readonly code: ProcessingErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProcessingError';
  }
}
