import type { BailianRecognitionCredentials } from '../../core/ocr-settings';
import type { Recognizer, RecognizerSource } from '../../core/contracts';
import type { CandidateVerificationRuntimeConfig } from '../../core/candidate-verification-settings';
import type { CandidateAdjudicator } from '../../core/candidate-verification';
import { BailianOcrClient } from './bailian-ocr-client';

export interface BailianRecognitionCredentialsProvider {
  getRecognitionCredentials(): Promise<BailianRecognitionCredentials>;
}

export interface CandidateVerificationRuntimeConfigProvider {
  getRuntimeConfig(): Promise<CandidateVerificationRuntimeConfig | null>;
}

export type CandidateAdjudicatorFactory = (
  configuration: CandidateVerificationRuntimeConfig,
) => CandidateAdjudicator;

export class ConfiguredBailianRecognizer implements Recognizer {
  public constructor(
    private readonly credentialsProvider: BailianRecognitionCredentialsProvider,
    private readonly client: Pick<BailianOcrClient, 'recognizeOrder'>,
    private readonly sellerAccount = '默认闲鱼账号',
    private readonly candidateVerificationProvider?:
      CandidateVerificationRuntimeConfigProvider,
    private readonly createCandidateAdjudicator?: CandidateAdjudicatorFactory,
  ) {}

  public async recognize(source: RecognizerSource) {
    const credentials = await this.credentialsProvider.getRecognitionCredentials();
    let candidateAdjudicator: CandidateAdjudicator | undefined;
    try {
      const candidateConfiguration = await this.candidateVerificationProvider
        ?.getRuntimeConfig();
      candidateAdjudicator = candidateConfiguration
        ? this.createCandidateAdjudicator?.(candidateConfiguration)
        : undefined;
    } catch {
      // Candidate adjudication is optional. A damaged verifier setting or
      // unavailable credential store must never prevent the primary OCR call.
      candidateAdjudicator = undefined;
    }
    return this.client.recognizeOrder({
      ...credentials,
      sellerAccount: this.sellerAccount,
      source,
      ...(candidateAdjudicator ? { candidateAdjudicator } : {}),
    });
  }
}
