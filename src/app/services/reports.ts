import { Injectable } from '@angular/core';

import {

  HttpClient,

  HttpParams,

} from '@angular/common/http';

import { Observable, map } from 'rxjs';

import { environment } from '../../environments/environment';

export interface LostFoundReport {

  id: number;

  user_id: number;

  report_type: 'lost' | 'found';

  item_name: string;

  description: string;

  category: string;

  barangay: string;

  specific_location: string | null;

  latitude: number | null;

  longitude: number | null;

  date_lost_found: string | null;
  time_lost_found?: string | null;

  image_url: string | null;

  status: 'active' | 'claimed' | 'returned' | 'closed';

  created_at: string;

  updated_at: string;

}

export interface ReportsResponse {

  reports: LostFoundReport[];

  limit: number;

  offset: number;

}

interface SingleReportResponse {

  report: LostFoundReport;

}

export interface ReportMutationResponse {

  message: string;

  report: LostFoundReport;

}

export interface PhotoUploadResponse {

  message: string;

  image_url: string;

}

export interface CreateReportData {

  report_type: 'lost' | 'found';

  item_name: string;

  description: string;

  category: string;

  barangay: string;

  specific_location: string | null;

  latitude: number | null;

  longitude: number | null;

  date_lost_found: string | null;
  time_lost_found?: string | null;

}

export type ClaimClosureReason =

  | 'verification_failed'

  | 'not_a_match'

  | 'owner_verified'

  | 'item_recovered';

export interface ClaimRequest {

  id: number;

  report_id: number;

  requester_id: number;

  requester_name?: string | null;

  requester_email?: string | null;

  report_owner_id?: number | null;

  item_name?: string | null;

  report_status?: LostFoundReport['status'] | null;

  report_type?: LostFoundReport['report_type'] | null;

  request_kind?: 'ownership_claim' | 'found_item_response' | null;

  message: string | null;

  // Private details available to authorized claim participants.

  verification_details?: string | null;

  owner_return_confirmed_at?: string | null;

  requester_return_confirmed_at?: string | null;

  status: 'pending' | 'approved' | 'rejected';

  // Explains why a rejected request was closed.

  // Historical requests may have a NULL value.

  closure_reason?: ClaimClosureReason | null;

  created_at: string | null;

  updated_at: string | null;

}

export interface ClaimSubmissionResponse {

  message: string;

  claim_id: number;

  report_type?: 'lost' | 'found';

  request_kind?: 'ownership_claim' | 'found_item_response';

  status: 'pending';

}

export interface ClaimDecisionResponse {

  message: string;

  status: string;

  closure_reason?: ClaimClosureReason | null;

  rejected_pending_claims?: number;

}

export interface NotAMatchResponse {

  message: string;

  status: 'rejected';

  closure_reason: 'not_a_match';

  report_status: 'active';

}

export interface ReturnConfirmationResponse {

  message: string;

  status: 'claimed' | 'returned';

  owner_return_confirmed: boolean;

  requester_return_confirmed: boolean;

}

@Injectable({

  providedIn: 'root',

})

export class ReportsService {

  private readonly apiUrl =

    `${environment.apiBaseUrl}/api/reports`;

  private readonly claimsUrl =

    `${environment.apiBaseUrl}/api/claims`;

  private readonly backendUrl = environment.apiBaseUrl;

  constructor(private http: HttpClient) {}

  // ============================================================

  // REPORT IMAGES

  // ============================================================

  getImageUrl(imagePath: string | null | undefined): string | null {
    if (!imagePath) {
      return null;
    }

    // Absolute image URLs should not be prefixed with the backend URL.
    if (/^https?:\/\//i.test(imagePath)) {
      return imagePath;
    }

    // Remove leading slashes from stored relative paths.
    return `${this.backendUrl}/${imagePath.replace(/^\/+/, '')}`;
  }

  // ============================================================

  // REPORT LISTS

  // ============================================================

  getReports(filters?: {

    report_type?: 'lost' | 'found';

    barangay?: string;

    category?: string;

    search?: string;

    limit?: number;

    offset?: number;

  }): Observable<ReportsResponse> {

    let params = new HttpParams();

    if (filters?.report_type) {

      params = params.set('report_type', filters.report_type);

    }

    if (filters?.barangay) {

      params = params.set('barangay', filters.barangay);

    }

    if (filters?.category) {

      params = params.set('category', filters.category);

    }

    if (filters?.search) {

      params = params.set('search', filters.search);

    }

    params = params

      .set('limit', filters?.limit ?? 20)

      .set('offset', filters?.offset ?? 0);

    return this.http.get<ReportsResponse>(

      this.apiUrl,

      { params },

    );

  }

  getReportById(id: number): Observable<LostFoundReport> {

    return this.http

      .get<SingleReportResponse>(`${this.apiUrl}/${id}`)

      .pipe(map((response) => response.report));

  }

  getMyReports(

    limit = 50,

    offset = 0,

  ): Observable<ReportsResponse> {

    const params = new HttpParams()

      .set('limit', limit)

      .set('offset', offset);

    return this.http.get<ReportsResponse>(

      `${this.apiUrl}/my`,

      { params },

    );

  }

  // ============================================================

  // CREATE / UPDATE / DELETE REPORTS

  // ============================================================

  createReport(

    data: CreateReportData,

  ): Observable<ReportMutationResponse> {

    return this.http.post<ReportMutationResponse>(

      this.apiUrl,

      data,

    );

  }

  updateReport(

    id: number,

    data: CreateReportData,

  ): Observable<ReportMutationResponse> {

    return this.http.put<ReportMutationResponse>(

      `${this.apiUrl}/${id}`,

      data,

    );

  }

  uploadReportPhoto(

    reportId: number,

    file: Blob,

  ): Observable<PhotoUploadResponse> {

    const formData = new FormData();

    const extension =

      file.type === 'image/png'

        ? 'png'

        : file.type === 'image/webp'

          ? 'webp'

          : 'jpg';

    formData.append(

      'file',

      file,

      `item-photo-${Date.now()}.${extension}`,

    );

    return this.http.post<PhotoUploadResponse>(

      `${this.apiUrl}/${reportId}/photo`,

      formData,

    );

  }

  deleteReport(

    id: number,

  ): Observable<{ message: string }> {

    return this.http.delete<{ message: string }>(

      `${this.apiUrl}/${id}`,

    );

  }

  // ============================================================

  // SUBMIT OWNERSHIP CLAIM / FINDER RESPONSE

  // ============================================================

  createClaimRequest(

    reportId: number,

    message: string,

    verificationDetails = '',

  ): Observable<ClaimSubmissionResponse> {

    return this.http.post<ClaimSubmissionResponse>(

      `${this.claimsUrl}/reports/${reportId}`,

      {

        message: message.trim() || null,

        verification_details: verificationDetails.trim(),

      },

    );

  }

  // ============================================================

  // CLAIM RETRIEVAL

  // ============================================================

  getMyClaimForReport(

    reportId: number,

  ): Observable<{ claim: ClaimRequest | null }> {

    return this.http.get<{ claim: ClaimRequest | null }>(

      `${this.claimsUrl}/reports/${reportId}/mine`,

    );

  }

  getMyClaimRequests(): Observable<{

    claims: ClaimRequest[];

  }> {

    return this.http.get<{ claims: ClaimRequest[] }>(

      `${this.claimsUrl}/mine`,

    );

  }

  getReceivedClaimRequests(): Observable<{

    claims: ClaimRequest[];

  }> {

    return this.http.get<{ claims: ClaimRequest[] }>(

      `${this.claimsUrl}/received`,

    );

  }

  // ============================================================

  // FOUND REPORT - APPROVE / REJECT

  // ============================================================

  decideClaimRequest(

    claimId: number,

    action: 'approve' | 'reject',

  ): Observable<ClaimDecisionResponse> {

    return this.http.patch<ClaimDecisionResponse>(

      `${this.claimsUrl}/${claimId}/decision`,

      { action },

    );

  }

  // ============================================================

  // LOST REPORT - NOT A MATCH

  // ============================================================

  /**

   * Allows the Lost Report owner to close an incorrect

   * finder response after private verification.

   *

   * The backend:

   * - Verifies that the logged-in user owns the Lost Report.

   * - Requires an active Lost Report.

   * - Requires a pending finder response.

   * - Sets status to 'rejected'.

   * - Sets closure_reason to 'not_a_match'.

   * - Notifies the responder.

   * - Leaves other pending responses unchanged.

   * - Keeps the Lost Report active.

   */

  markFinderResponseNotAMatch(

    claimId: number,

  ): Observable<NotAMatchResponse> {

    return this.http.patch<NotAMatchResponse>(

      `${this.claimsUrl}/${claimId}/not-a-match`,

      {},

    );

  }

  // ============================================================

  // CONFIRM PHYSICAL HANDOVER

  // ============================================================

  /**

   * FOUND REPORT:

   * The finder and approved owner confirm the actual handover.

   *

   * LOST REPORT:

   * The Lost Report owner confirms physical receipt first.

   * The selected finder confirms the handover afterward.

   *

   * The backend marks the report 'returned' only after both

   * parties have confirmed.

   */

  confirmItemReturned(

    claimId: number,

  ): Observable<ReturnConfirmationResponse> {

    return this.http.post<ReturnConfirmationResponse>(

      `${this.claimsUrl}/${claimId}/return`,

      {},

    );

  }

}