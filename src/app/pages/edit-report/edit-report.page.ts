import { CommonModule } from '@angular/common';
import {
  Component,
  ChangeDetectorRef,
  OnInit,
  OnDestroy,
  ElementRef,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Geolocation } from '@capacitor/geolocation';
import * as L from 'leaflet';
import { ActivatedRoute, Router } from '@angular/router';

import {
  AlertController,
  LoadingController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
  IonIcon,
} from '@ionic/angular';

import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  locationOutline,
  checkmarkCircleOutline,
  imageOutline,
  imagesOutline,
  checkmarkOutline,
} from 'ionicons/icons';

import { Subscription, timeout } from 'rxjs';

import {
  CreateReportData,
  LostFoundReport,
  ReportsService,
} from '../../services/reports';

import { HapticsService } from '../../services/haptics';

// Icons used by the redesigned Edit Report template.
addIcons({
  arrowBackOutline,
  locationOutline,
  checkmarkCircleOutline,
  imageOutline,
  imagesOutline,
  checkmarkOutline,
});

type BoundaryGeometry = {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: number[][][] | number[][][][];
};
type BoundaryFeature = {
  type: 'Feature';
  properties: { brgy_name: string };
  geometry: BoundaryGeometry;
};
type BoundaryCollection = {
  type: 'FeatureCollection';
  features: BoundaryFeature[];
};

@Component({
  selector: 'app-edit-report',
  standalone: true,
  templateUrl: './edit-report.page.html',
  styleUrls: ['./edit-report.page.scss'],
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonInput,
    IonTextarea,
    IonSelect,
    IonSelectOption,
    IonButton,
    IonButtons,
    IonSpinner,
    IonIcon,
  ],
})
export class EditReportPage implements OnInit, OnDestroy {

  // Map is created when the form becomes visible (after API load).
  @ViewChild('incidentMap')
  set incidentMapElement(element: ElementRef<HTMLDivElement> | undefined) {
    if (!element || this.destroyed) return;
    setTimeout(() => {
      if (!this.destroyed && !this.isLoading && element.nativeElement.isConnected) {
        void this.initializeIncidentMap(element.nativeElement);
      }
    }, 60);
  }

  private incidentMap: L.Map | null = null;
  private incidentMarker: L.CircleMarker | null = null;
  private boundaryLayer: L.GeoJSON | null = null;
  private boundaryFeatures: BoundaryFeature[] | null = null;
  private boundaryLoading: Promise<BoundaryFeature[]> | null = null;
  private mapElement: HTMLDivElement | null = null;
  private mapLoadId = 0;
  private readonly boundaryAssetPath =
    'assets/geo/san_leonardo_barangay_boundaries.geojson';
  private readonly geoBarangayNames: Record<string, string> = {
    'San Bartolome (Pob.)': 'San Bartolome',
    'Burgos District (Pob.)': 'Burgos',
    'Rizal District (Pob.)': 'Rizal',
    'Bonifacio District (Pob.)': 'Bonifacio',
    'Tambo Adorable': 'Tambo-Adorable',
  };


  // ==========================================
  // REPORT FORM DATA
  // ==========================================

  reportId = 0;

  reportType: 'lost' | 'found' = 'lost';

  itemName = '';
  description = '';
  category = '';
  barangay = '';
  specificLocation = '';
  dateLostFound = '';

  // ==========================================
  // GPS LOCATION
  // ==========================================

  latitude: number | null = null;
  longitude: number | null = null;

  isGettingLocation = false;

  // ==========================================
  // PAGE STATE
  // ==========================================

  isLoading = true;
  isSubmitting = false;
  errorMessage = '';

  // ==========================================
  // PHOTO STATE
  // ==========================================

  selectedPhoto: File | null = null;

  currentPhotoUrl: string | null = null;
  photoPreview: string | null = null;
  photoError = '';

  private readonly maxPhotoSize =
    5 * 1024 * 1024;

  private readonly allowedPhotoTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
  ];

  // ==========================================
  // UNSAVED CHANGES PROTECTION
  // ==========================================

  private originalFormSnapshot: string | null = null;

  private isDiscardConfirmationOpen = false;

  // ==========================================
  // SUBSCRIPTIONS
  // ==========================================

  private reportRequest?: Subscription;
  private updateRequest?: Subscription;
  private photoUploadRequest?: Subscription;

  private destroyed = false;
  private hasLoadedInitially = false;
  private reportLoadGeneration = 0;
  private activeFormReportId = 0;

  // ==========================================
  // BARANGAYS
  // ==========================================

  barangays = [
    'San Bartolome',
    'Burgos',
    'Rizal',
    'Bonifacio',
    'Mallorca',
    'Mambangnan',
    'Diversion',
    'Tambo-Adorable',
    'Nieves',
    'Tabuating',
    'Magpapalayoc',
    'San Anton',
    'Castellano',
    'Tagumpay',
    'San Roque',
  ];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private reportsService: ReportsService,
    private alertController: AlertController,
    private loadingController: LoadingController,
    private changeDetector: ChangeDetectorRef,
    private haptics: HapticsService,
  ) {}

  // ==========================================
  // INITIALIZATION
  // ==========================================

  ngOnInit(): void {
    this.reportId = Number(
      this.route.snapshot.paramMap.get('id'),
    );

    if (
      !Number.isInteger(this.reportId) ||
      this.reportId <= 0
    ) {
      this.isLoading = false;
      this.errorMessage = 'Invalid report ID.';

      this.refreshUI();
      return;
    }

    this.loadReport();
  }

  // ==========================================
  // PAGE REFRESH
  // ==========================================

  ionViewWillEnter(): void {
    setTimeout(() => this.incidentMap?.invalidateSize(), 100);
    if (this.hasLoadedInitially) {
      // Do not overwrite any changes that are
      // currently being edited.
      if (!this.hasUnsavedChanges()) {
        this.loadReport(true);
      }
    }

    this.hasLoadedInitially = true;
  }

  // ==========================================
  // COMPONENT CLEANUP
  // ==========================================

  ngOnDestroy(): void {
    this.destroyed = true;

    this.reportLoadGeneration++;
    this.reportRequest?.unsubscribe();
    this.updateRequest?.unsubscribe();
    this.photoUploadRequest?.unsubscribe();
    this.destroyIncidentMap();
  }

  // ==========================================
  // UI REFRESH
  // ==========================================

  private refreshUI(): void {
    if (!this.destroyed) {
      this.changeDetector.detectChanges();
    }
  }

  // ==========================================
  // NORMALIZED FORM SNAPSHOT
  // ==========================================

  private createFormSnapshot(): string {
    return JSON.stringify({
      reportType: this.reportType,

      itemName: this.itemName.trim(),

      description: this.description.trim(),

      category: this.category,

      barangay: this.barangay,

      specificLocation: this.specificLocation.trim(),

      dateLostFound: this.dateLostFound || '',

      latitude: this.latitude,

      longitude: this.longitude,
    });
  }

  // ==========================================
  // STORE ORIGINAL VALUES
  // ==========================================

  private rememberOriginalForm(): void {
    this.originalFormSnapshot =
      this.createFormSnapshot();
  }

  // ==========================================
  // DETECT UNSAVED CHANGES
  // ==========================================

  hasUnsavedChanges(): boolean {
    // A newly selected replacement photo is
    // always an unsaved change.
    if (this.selectedPhoto !== null) {
      return true;
    }

    if (this.originalFormSnapshot === null) {
      return false;
    }

    return (
      this.createFormSnapshot() !==
      this.originalFormSnapshot
    );
  }

  // ==========================================
  // LOAD EXISTING REPORT
  // ==========================================

  loadReport(force = false): void {
    if (
      this.destroyed ||
      this.isSubmitting ||
      this.isGettingLocation ||
      this.reportId <= 0
    ) {
      return;
    }

    if (
      !force &&
      this.reportRequest &&
      !this.reportRequest.closed
    ) {
      return;
    }

    // Prevent a refresh from silently replacing
    // edited values.
    if (
      this.originalFormSnapshot !== null &&
      this.hasUnsavedChanges()
    ) {
      return;
    }

    this.reportLoadGeneration++;
    const loadGeneration = this.reportLoadGeneration;
    const requestedReportId = this.reportId;
    this.reportRequest?.unsubscribe();

    this.isLoading = true;
    this.errorMessage = '';

    this.refreshUI();

    this.reportRequest = this.reportsService
      .getReportById(this.reportId)
      .pipe(timeout(15000))
      .subscribe({
        next: (report: LostFoundReport) => {
          if (
            this.destroyed ||
            loadGeneration !== this.reportLoadGeneration ||
            requestedReportId !== this.reportId ||
            this.hasUnsavedChanges()
          ) {
            return;
          }

          this.reportType = report.report_type;
          this.itemName = report.item_name;
          this.description = report.description;
          this.category = report.category;
          this.barangay = report.barangay;

          this.specificLocation =
            report.specific_location ?? '';

          this.dateLostFound =
            report.date_lost_found
              ? report.date_lost_found.substring(0, 10)
              : '';

          this.latitude =
            report.latitude ?? null;

          this.longitude =
            report.longitude ?? null;

          this.currentPhotoUrl =
            this.reportsService.getImageUrl(
              report.image_url,
            );

          // Clear any previous temporary photo
          // when loading a fresh saved report.
          this.selectedPhoto = null;
          this.photoPreview = null;
          this.photoError = '';

          // Baseline for unsaved-change detection.
          this.rememberOriginalForm();
          this.activeFormReportId = requestedReportId;

          this.isLoading = false;
          this.refreshUI();
          // On cached pages, Leaflet may already be mounted.
          // The @ViewChild setter initializes the map for first-time loads.
          this.syncExistingIncidentMarker();
        },

        error: (error) => {
          if (
            this.destroyed ||
            loadGeneration !== this.reportLoadGeneration ||
            requestedReportId !== this.reportId
          ) {
            return;
          }

          console.error(
            'Load report error:',
            error,
          );

          this.isLoading = false;

          this.errorMessage =
            error?.error?.detail ||
            'Unable to load this report. Please try again.';

          this.refreshUI();
        },
      });
  }

  // ==========================================
  // GET CURRENT GPS LOCATION
  // ==========================================

  async useCurrentLocation(): Promise<void> {
    if (this.destroyed || this.isLoading || this.isSubmitting || this.isGettingLocation) return;
    this.isGettingLocation = true;
    this.refreshUI();
    let loading: Awaited<ReturnType<LoadingController['create']>> | undefined;
    try {
      loading = await this.loadingController.create({ message: 'Getting your current location...' });
      await loading.present();
      let permission = await Geolocation.checkPermissions();
      if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') {
        permission = await Geolocation.requestPermissions();
      }
      if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') {
        throw new Error('LOCATION_PERMISSION_DENIED');
      }
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true, timeout: 20000, maximumAge: 0,
      });
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      if (!this.validCoordinates(lat, lon)) throw new Error('INVALID_COORDINATES');
      const matched = await this.matchBarangay(lon, lat);
      if (!matched) throw new Error('OUTSIDE_SAN_LEONARDO');
      if (this.destroyed) return;
      this.latitude = lat;
      this.longitude = lon;
      this.barangay = matched;
      this.updateIncidentMarker(lat, lon);
      this.incidentMap?.setView([lat, lon], 16);
      this.refreshUI();
      await this.haptics.success();
      await this.showAlert('Incident Location Selected',
        'Your current GPS location was selected. Make sure this is the actual place where the item was lost or found.');
    } catch (error: unknown) {
      if (this.destroyed) return;
      console.error('Edit report location error:', error);
      const code = error instanceof Error ? error.message : String(error);
      let message = 'Unable to get your current location. Please check your location settings and try again.';
      if (code === 'OUTSIDE_SAN_LEONARDO') {
        message = 'Your phone is outside San Leonardo. Select the actual incident location on the map instead.';
      } else if (code === 'LOCATION_PERMISSION_DENIED' || code.toLowerCase().includes('denied')) {
        message = 'Location permission was denied. Allow location access in your device settings.';
      } else if (code === 'BOUNDARY_UNAVAILABLE') {
        message = 'The San Leonardo boundary data is unavailable. Check the GeoJSON asset and try again.';
      } else if (code === 'INVALID_COORDINATES') {
        message = 'The device returned invalid coordinates. Please try again.';
      } else if (code.toLowerCase().includes('timeout')) {
        message = 'Getting your location took too long. Please try again.';
      }
      await this.haptics.warning();
      await this.showAlert('Location Unavailable', message);
    } finally {
      if (loading) {
        try { await loading.dismiss(); } catch { /* Overlay already closed. */ }
      }
      this.isGettingLocation = false;
      this.refreshUI();
    }
  }

  // ==========================================
  // CLEAR GPS LOCATION
  // ==========================================

  clearLocation(): void {
    if (
      this.isSubmitting ||
      this.isGettingLocation ||
      this.isLoading
    ) {
      return;
    }

    this.latitude = null;
    this.longitude = null;
    this.incidentMarker?.remove();
    this.incidentMarker = null;

    this.refreshUI();
  }

  private validCoordinates(lat: number, lon: number): boolean {
    return Number.isFinite(lat) && Number.isFinite(lon) &&
      lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  private syncExistingIncidentMarker(): void {
    if (!this.incidentMap) return;
    if (this.latitude !== null && this.longitude !== null &&
        this.validCoordinates(this.latitude, this.longitude)) {
      this.updateIncidentMarker(this.latitude, this.longitude);
      this.incidentMap.setView([this.latitude, this.longitude], 15);
    } else {
      this.incidentMarker?.remove();
      this.incidentMarker = null;
    }
    setTimeout(() => this.incidentMap?.invalidateSize(), 100);
  }

  private async getBoundaryFeatures(): Promise<BoundaryFeature[]> {
    if (this.boundaryFeatures) return this.boundaryFeatures;
    if (!this.boundaryLoading) {
      this.boundaryLoading = (async () => {
        const response = await fetch(this.boundaryAssetPath, { cache: 'force-cache' });
        if (!response.ok) throw new Error('BOUNDARY_UNAVAILABLE');
        const collection = await response.json() as BoundaryCollection;
        if (collection.type !== 'FeatureCollection' ||
            !Array.isArray(collection.features) || collection.features.length !== 15) {
          throw new Error('BOUNDARY_UNAVAILABLE');
        }
        const expected = new Set(this.barangays);
        const seen = new Set<string>();
        for (const feature of collection.features) {
          const name = this.geoBarangayNames[feature.properties?.brgy_name] ||
            feature.properties?.brgy_name;
          if (!expected.has(name) || seen.has(name) ||
              !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type) ||
              !feature.geometry?.coordinates?.length) {
            throw new Error('BOUNDARY_UNAVAILABLE');
          }
          seen.add(name);
        }
        this.boundaryFeatures = collection.features;
        return collection.features;
      })().catch((error) => {
        this.boundaryLoading = null; // Retry after a temporary network failure.
        throw error;
      });
    }
    return this.boundaryLoading;
  }

  private pointOnSegment(lon: number, lat: number,
    ax: number, ay: number, bx: number, by: number): boolean {
    const epsilon = 1e-11;
    const cross = (lon - ax) * (by - ay) - (lat - ay) * (bx - ax);
    return Math.abs(cross) <= epsilon &&
      lon >= Math.min(ax, bx) - epsilon && lon <= Math.max(ax, bx) + epsilon &&
      lat >= Math.min(ay, by) - epsilon && lat <= Math.max(ay, by) + epsilon;
  }

  private ringPosition(ring: number[][], lon: number, lat: number):
    'outside' | 'inside' | 'border' {
    let inside = false;
    if (!ring || ring.length < 4) return 'outside';
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      if (this.pointOnSegment(lon, lat, ax, ay, bx, by)) return 'border';
      if ((ay > lat) !== (by > lat)) {
        const intersectLon = ax + (lat - ay) * (bx - ax) / (by - ay);
        if (lon < intersectLon) inside = !inside;
      }
    }
    return inside ? 'inside' : 'outside';
  }

  private coversPoint(geometry: BoundaryGeometry, lon: number, lat: number): boolean {
    const polygons = geometry.type === 'Polygon'
      ? [geometry.coordinates as number[][][]]
      : geometry.coordinates as number[][][][];
    for (const rings of polygons) {
      if (!rings.length) continue;
      const position = this.ringPosition(rings[0], lon, lat);
      if (position === 'outside') continue;
      if (position === 'border') return true;
      let inHole = false;
      for (const hole of rings.slice(1)) {
        const holePosition = this.ringPosition(hole, lon, lat);
        if (holePosition === 'border') return true;
        if (holePosition === 'inside') { inHole = true; break; }
      }
      if (!inHole) return true;
    }
    return false;
  }

  private async matchBarangay(lon: number, lat: number): Promise<string | null> {
    const features = await this.getBoundaryFeatures();
    for (const feature of features) {
      if (this.coversPoint(feature.geometry, lon, lat)) {
        return this.geoBarangayNames[feature.properties.brgy_name] ||
          feature.properties.brgy_name;
      }
    }
    return null;
  }

  private async initializeIncidentMap(element: HTMLDivElement): Promise<void> {
    if (this.destroyed || this.isLoading) return;
    if (this.incidentMap && this.mapElement === element) {
      this.incidentMap.invalidateSize();
      return;
    }
    this.destroyIncidentMap();
    const loadId = this.mapLoadId;
    try {
      const features = await this.getBoundaryFeatures();
      if (this.destroyed || this.isLoading ||
          !element.isConnected || loadId !== this.mapLoadId) return;

      const map = L.map(element, {
        zoomControl: true,
        scrollWheelZoom: false, // Prevent the page scrolling from accidentally zooming.
      });
      this.incidentMap = map;
      this.mapElement = element;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      const boundaries: BoundaryCollection = { type: 'FeatureCollection', features };
      const layer = L.geoJSON(boundaries as unknown as GeoJSON.GeoJsonObject, {
        style: {
          color: '#0758d3', weight: 2, fillColor: '#0758d3',
          fillOpacity: 0.08,
        },
      }).addTo(map);
      this.boundaryLayer = layer;
      map.fitBounds(layer.getBounds().pad(0.1));
      map.on('click', (event: L.LeafletMouseEvent) => {
        void this.selectMapPosition(event.latlng.lat, event.latlng.lng);
      });
      this.syncExistingIncidentMarker();
      setTimeout(() => {
        if (this.incidentMap === map) map.invalidateSize();
      }, 150);
    } catch (error) {
      console.error('Map initialization failed', error);
      if (!this.destroyed && !this.isLoading) {
        await this.showAlert('Map Unavailable',
          'San Leonardo boundary data could not be loaded. Please verify the boundary asset is installed and try again.');
      }
    }
  }

  private async selectMapPosition(lat: number, lon: number): Promise<void> {
    if (this.destroyed || this.isLoading ||
        this.isSubmitting || this.isGettingLocation) return;
    const selectedReportId = this.reportId;
    try {
      const matched = await this.matchBarangay(lon, lat);
      if (this.destroyed || this.reportId !== selectedReportId) return;
      if (!matched) {
        await this.haptics.warning();
        await this.showAlert('Outside San Leonardo',
          'Please place the pin inside San Leonardo, Nueva Ecija. Reports outside the municipality are not accepted.');
        return;
      }
      this.latitude = lat;
      this.longitude = lon;
      this.barangay = matched;
      this.updateIncidentMarker(lat, lon);
      this.refreshUI();
    } catch {
      await this.showAlert('Location Validation Unavailable',
        'The boundary data could not be loaded. Please try again.');
    }
  }

  private updateIncidentMarker(lat: number, lon: number): void {
    if (!this.incidentMap) return;
    this.incidentMarker?.remove();
    this.incidentMarker = L.circleMarker([lat, lon], {
      radius: 8, color: '#ffffff', weight: 3,
      fillColor: '#0758d3', fillOpacity: 1,
    }).addTo(this.incidentMap);
  }

  private destroyIncidentMap(): void {
    this.mapLoadId++;
    this.incidentMarker?.remove();
    this.incidentMarker = null;
    if (this.incidentMap) this.incidentMap.remove();
    this.incidentMap = null;
    this.boundaryLayer = null;
    this.mapElement = null;
  }

  private async validateSelectedLocation(): Promise<boolean> {
    if (this.latitude === null || this.longitude === null) {
      await this.showAlert('Incident Location Required',
        'Select the actual lost/found location on the map or use GPS to continue.');
      return false;
    }
    if (!this.validCoordinates(this.latitude, this.longitude)) {
      await this.showAlert('Invalid Location', 'Please choose a valid incident location.');
      return false;
    }
    try {
      const matched = await this.matchBarangay(this.longitude, this.latitude);
      if (!matched) {
        await this.showAlert('Outside San Leonardo',
          'Reports can only be submitted for items lost or found inside San Leonardo.');
        return false;
      }
      // The pin is authoritative; correct the dropdown if it differs.
      if (this.barangay !== matched) this.barangay = matched;
      this.refreshUI();
      return true;
    } catch {
      await this.showAlert('Location Validation Unavailable',
        'Unable to verify the San Leonardo boundary. Check the installed GeoJSON asset and try again.');
      return false;
    }
  }
  // ==========================================
  // SELECT REPLACEMENT PHOTO
  // ==========================================

  onPhotoSelected(event: Event): void {
    if (
      this.isSubmitting ||
      this.isLoading
    ) {
      return;
    }

    const input =
      event.target as HTMLInputElement;

    const file = input.files?.[0];

    this.photoError = '';

    if (!file) {
      return;
    }

    if (
      !this.allowedPhotoTypes.includes(
        file.type,
      )
    ) {
      this.selectedPhoto = null;
      this.photoPreview = null;

      this.photoError =
        'Please select a JPG, PNG, or WEBP image.';

      input.value = '';

      void this.haptics.warning();

      this.refreshUI();
      return;
    }

    if (file.size === 0 || file.size > this.maxPhotoSize) {
      this.selectedPhoto = null;
      this.photoPreview = null;

      this.photoError =
        'The image must not exceed 5 MB.';

      input.value = '';

      void this.haptics.warning();

      this.refreshUI();
      return;
    }

    this.selectedPhoto = file;
    this.photoPreview = null;

    this.refreshUI();

    const reader = new FileReader();

    reader.onload = () => {
      if (
        this.destroyed ||
        this.selectedPhoto !== file
      ) {
        return;
      }

      if (typeof reader.result === 'string') {
        this.photoPreview =
          reader.result;

        this.refreshUI();
      }
    };

    reader.onerror = () => {
      if (
        this.destroyed ||
        this.selectedPhoto !== file
      ) {
        return;
      }

      this.selectedPhoto = null;
      this.photoPreview = null;

      this.photoError =
        'Unable to preview this image. Please try another.';

      input.value = '';

      void this.haptics.warning();

      this.refreshUI();
    };

    reader.readAsDataURL(file);
  }

  // ==========================================
  // CANCEL PHOTO REPLACEMENT
  // ==========================================

  cancelPhotoChange(
    input: HTMLInputElement,
  ): void {
    if (this.isSubmitting) {
      return;
    }

    this.selectedPhoto = null;
    this.photoPreview = null;
    this.photoError = '';

    input.value = '';

    this.refreshUI();
  }

  // ==========================================
  // SAVE REPORT CHANGES
  // ==========================================

  async submitChanges(): Promise<void> {
    if (
      this.destroyed ||
      this.reportId <= 0 ||
      this.activeFormReportId !== this.reportId ||
      this.isSubmitting ||
      this.isGettingLocation ||
      this.isLoading
    ) {
      return;
    }

    if (
      !['lost', 'found'].includes(this.reportType) ||
      !this.itemName.trim() ||
      !this.description.trim() ||
      !this.category ||
      !this.barangay
    ) {
      await this.haptics.warning();

      await this.showAlert(
        'Missing Information',
        'Please complete the item name, description, category, and barangay.',
      );

      return;
    }

    // The actual incident location is mandatory under San Leonardo-only rules.
    if (!await this.validateSelectedLocation()) {
      await this.haptics.warning();
      return;
    }

    this.isSubmitting = true;
    this.errorMessage = '';

    this.refreshUI();

    const reportData: CreateReportData = {
      report_type: this.reportType,
      item_name: this.itemName.trim(),
      description: this.description.trim(),
      category: this.category,
      barangay: this.barangay,
      specific_location:
        this.specificLocation.trim() || null,
      date_lost_found:
        this.dateLostFound || null,
      latitude: this.latitude,
      longitude: this.longitude,
    };

    this.updateRequest?.unsubscribe();

    this.updateRequest = this.reportsService
      .updateReport(
        this.reportId,
        reportData,
      )
      .pipe(timeout(20000))
      .subscribe({
        next: () => {
          if (this.destroyed) {
            return;
          }

          // Report details have been saved.
          // If the photo upload fails later,
          // we must not pretend the entire
          // update failed.
          this.rememberOriginalForm();

          if (!this.selectedPhoto) {
            void this.finishUpdate();
            return;
          }

          const photo = this.selectedPhoto;

          this.photoUploadRequest?.unsubscribe();

          this.photoUploadRequest =
            this.reportsService
              .uploadReportPhoto(
                this.reportId,
                photo,
              )
              .pipe(timeout(45000))
              .subscribe({
                next: (response) => {
                  if (this.destroyed) {
                    return;
                  }

                  this.currentPhotoUrl =
                    this.reportsService.getImageUrl(
                      response.image_url,
                    );

                  this.selectedPhoto = null;
                  this.photoPreview = null;
                  this.photoError = '';

                  this.refreshUI();

                  void this.finishUpdate();
                },

                error: async (error) => {
                  if (this.destroyed) {
                    return;
                  }

                  console.error(
                    'Photo upload error:',
                    error,
                  );

                  this.isSubmitting = false;
                  this.refreshUI();

                  await this.haptics.warning();

                  await this.showAlert(
                    'Details Saved, Photo Upload Failed',
                    'Your report details were updated, but the new photo could not be uploaded. You can try saving the selected photo again.',
                  );
                },
              });
        },

        error: async (error) => {
          if (this.destroyed) {
            return;
          }

          this.isSubmitting = false;
          this.refreshUI();

          console.error(
            'Update report error:',
            error,
          );

          await this.haptics.warning();

          let message =
            'Unable to update your report. Please try again.';

          if (error?.name === 'TimeoutError') {
            message =
              'The server took too long to respond. Please check your report before trying again.';
          } else if (error.status === 0) {
            message =
              'Cannot connect to the backend. Please check your server.';
          } else if (error.status === 401) {
            message =
              'Please log in again before updating a report.';
          } else if (error.status === 403) {
            message =
              'You are not allowed to edit this report.';
          } else if (error.status === 404) {
            message =
              'This report could not be found.';
          } else if (typeof error?.error?.detail === 'string') {
            message = error.error.detail;
          } else if (error.status === 422) {
            message = 'Some information is invalid. Please review the form.';
          }

          await this.showAlert(
            'Update Failed',
            message,
          );
        },
      });
  }

  // ==========================================
  // FINISH SUCCESSFUL UPDATE
  // ==========================================

  private async finishUpdate(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.isSubmitting = false;
    this.refreshUI();

    await this.haptics.success();

    if (this.destroyed) {
      return;
    }

    const alert =
      await this.alertController.create({
        header: 'Report Updated',
        message:
          'Your report was updated successfully. You will now return to My Reports.',
        backdropDismiss: false,
        buttons: [
          {
            text: 'OK',
            role: 'confirm',
          },
        ],
      });

    await alert.present();
    await alert.onDidDismiss();

    if (!this.destroyed) {
      await this.router.navigateByUrl(
        '/my-reports',
      );
    }
  }

  // ==========================================
  // BACK / CANCEL WITH DISCARD CONFIRMATION
  // ==========================================

  async goBack(): Promise<void> {
    if (
      this.destroyed ||
      this.isSubmitting ||
      this.isGettingLocation ||
      this.isDiscardConfirmationOpen
    ) {
      return;
    }

    // No unsaved changes: navigate immediately.
    if (!this.hasUnsavedChanges()) {
      await this.router.navigateByUrl(
        '/my-reports',
      );

      return;
    }

    // Unsaved changes detected: ask the user.
    this.isDiscardConfirmationOpen = true;

    try {
      const alert =
        await this.alertController.create({
          header: 'Discard Changes?',
          message:
            'You have unsaved changes in this report. Leaving now will discard those changes. Do you want to continue?',
          backdropDismiss: false,

          buttons: [
            {
              text: 'Keep Editing',
              role: 'cancel',
            },
            {
              text: 'Discard Changes',
              role: 'destructive',
            },
          ],
        });

      await alert.present();

      const result = await alert.onDidDismiss();

      if (
        result.role === 'destructive' &&
        !this.destroyed
      ) {
        // Clear temporary edits before leaving.
        this.selectedPhoto = null;
        this.photoPreview = null;
        this.photoError = '';

        // Navigation is explicit and only occurs
        // after the user confirms discarding.
        await this.router.navigateByUrl(
          '/my-reports',
        );
      }
    } finally {
      this.isDiscardConfirmationOpen = false;
    }
  }

  // ==========================================
  // GENERAL ALERT
  // ==========================================

  private async showAlert(
    header: string,
    message: string,
  ): Promise<void> {
    if (this.destroyed) {
      return;
    }

    const alert =
      await this.alertController.create({
        header,
        message,
        buttons: ['OK'],
      });

    if (!this.destroyed) {
      await alert.present();
    }
  }
}