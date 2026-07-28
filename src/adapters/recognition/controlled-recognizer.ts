import type {
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../../core/contracts';

export class ControlledRecognizer implements Recognizer {
  public networkRequestCount = 0;

  public constructor(private readonly result: RecognitionResult) {}

  public async recognize(_source: RecognizerSource): Promise<RecognitionResult> {
    return structuredClone(this.result);
  }
}
