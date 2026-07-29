import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../../core/contracts';

export class ControlledRecognizer implements Recognizer {
  public networkRequestCount = 0;

  public constructor(private readonly result: RecognitionResult) {}

  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result = structuredClone(this.result);
    return {
      result,
      evidences: [
        {
          provider: 'controlled',
          model: 'controlled',
          requestId: '',
          schemaVersion: 1,
          rawResponse: JSON.stringify(result),
        },
      ],
    };
  }
}
