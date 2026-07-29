import type { BailianRecognitionCredentials } from '../../core/ocr-settings';
import type { Recognizer, RecognizerSource } from '../../core/contracts';
import { BailianOcrClient } from './bailian-ocr-client';

export interface BailianRecognitionCredentialsProvider {
  getRecognitionCredentials(): Promise<BailianRecognitionCredentials>;
}

export class ConfiguredBailianRecognizer implements Recognizer {
  public constructor(
    private readonly credentialsProvider: BailianRecognitionCredentialsProvider,
    private readonly client: BailianOcrClient,
    private readonly sellerAccount = '默认闲鱼账号',
  ) {}

  public async recognize(source: RecognizerSource) {
    const credentials = await this.credentialsProvider.getRecognitionCredentials();
    return this.client.recognizeOrder({
      ...credentials,
      sellerAccount: this.sellerAccount,
      source,
    });
  }
}
