import {
  Component,
  OnDestroy,
  NgZone,
  ChangeDetectorRef,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AlertController,
  IonButton,
  IonContent,
  IonFooter,
  IonHeader,
  IonInput,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonToolbar,
  LoadingController,
  IonIcon,
} from '@ionic/angular';
import {
  Camera,
  CameraResultType,
  CameraSource,
} from '@capacitor/camera';
import { Geolocation } from '@capacitor/geolocation';
import * as L from 'leaflet';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  locationOutline,
  checkmarkCircleOutline,
  cameraOutline,
  imagesOutline,
} from 'ionicons/icons';
import { ReportsService } from '../../services/reports';
import { HapticsService } from '../../services/haptics';
// Icons used by the Create Report template.
addIcons({
  arrowBackOutline,
  locationOutline,
  checkmarkCircleOutline,
  cameraOutline,
  imagesOutline,
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
  selector: 'app-create-report',
  standalone: true,
  templateUrl: './create-report.page.html',
  styleUrls: ['./create-report.page.scss'],
  imports: [
    FormsModule,
    IonHeader,
    IonToolbar,
    IonContent,
    IonFooter,
    IonInput,
    IonTextarea,
    IonSelect,
    IonSelectOption,
    IonButton,
    IonIcon
  ],
})
export class CreateReportPage implements OnDestroy {
  @ViewChild(IonContent) private reportContent?: IonContent;

  // Step 2 is rendered conditionally; initialize the map when its DIV exists.
  @ViewChild('incidentMap')
  set incidentMapElement(element: ElementRef<HTMLDivElement> | undefined) {
    if (!element || this.destroyed) return;
    // Ionic's conditional step needs a rendering frame before Leaflet measures it.
    setTimeout(() => {
      if (!this.destroyed && this.reportStep === 2 && element.nativeElement.isConnected) {
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


  // Navigation between compact form screens.
  reportStep: 1 | 2 | 3 = 1;
  // ==========================================
  // REPORT INFORMATION
  // ==========================================
  reportType: 'lost' | 'found' = 'lost';
  itemName = '';
  description = '';
  category = '';
  barangay = '';
  specificLocation = '';
  dateLostFound = '';
  timeLostFound = '';
  // ==========================================
  // GPS LOCATION
  // ==========================================
  latitude: number | null = null;
  longitude: number | null = null;
  isGettingLocation = false;
  // ==========================================
  // SUBMISSION STATE
  // ==========================================
  isSubmitting = false;
  isSelectingPhoto = false;
  // ==========================================
  // PHOTO
  // ==========================================
  selectedPhoto: Blob | null = null;
  photoPreview: string | null = null;
  photoError = '';
  private readonly maxPhotoSize = 5 * 1024 * 1024;
  private readonly allowedPhotoTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
  ];
  // ==========================================
  // COMPONENT STATE
  // ==========================================
  private destroyed = false;
  private readonly activeRequests = new Subscription();
  private photoReader?: FileReader;
  private isBackConfirmationOpen = false;
  // Once created, prevent a second submission of the same report.
  private createdReportId: number | null = null;
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
    private reportsService: ReportsService,
    private alertController: AlertController,
    private router: Router,
    private loadingController: LoadingController,
    private haptics: HapticsService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {}
  // Ionic may cache this page when navigating back to Home.
  // Prepare a fresh form only when a previous report was already saved.
  ionViewWillEnter(): void {
    if (this.createdReportId === null) {
      setTimeout(() => this.incidentMap?.invalidateSize(), 100);
      return;
    }
    this.createdReportId = null;
    this.reportStep = 1;
    this.reportType = 'lost';
    this.itemName = '';
    this.description = '';
    this.category = '';
    this.barangay = '';
    this.specificLocation = '';
    this.dateLostFound = '';
    this.timeLostFound = '';
    this.latitude = null;
    this.longitude = null;
    this.destroyIncidentMap();
    this.photoReader?.abort();
    this.photoReader = undefined;
    this.clearSelectedPhoto();
    this.photoError = '';
    this.isSubmitting = false;
    this.isSelectingPhoto = false;
    this.isGettingLocation = false;
    this.refreshUI();
  }
  // ==========================================
  // THREE-STEP FORM NAVIGATION
  // ==========================================
  async nextReportStep(): Promise<void> {
    if (
      this.destroyed || this.isSubmitting ||
      this.isGettingLocation || this.isSelectingPhoto ||
      this.createdReportId !== null
    ) return;

    if (this.reportStep === 1) {
      if (this.reportType !== 'lost' && this.reportType !== 'found') {
        await this.showAlert('Report Type Required', 'Choose Lost Item or Found Item.');
        return;
      }
      if (!this.itemName.trim() || !this.description.trim() || !this.category.trim()) {
        await this.showAlert(
          'Incomplete Item Details',
          'Please enter the item name, description, and category.',
        );
        return;
      }
      this.reportStep = 2;
    } else if (this.reportStep === 2) {
      if (!await this.validateIncidentDateTime()) return;
      if (!await this.validateSelectedLocation()) return;
      this.reportStep = 3;
    } else {
      return;
    }

    if (this.reportStep !== 2) this.destroyIncidentMap();
    this.refreshUI();
    await this.scrollToStepTop();
  }

  async handleReportBack(): Promise<void> {
    if (
      this.destroyed || this.isSubmitting ||
      this.isGettingLocation || this.isSelectingPhoto ||
      this.isBackConfirmationOpen
    ) return;

    // Do not let users edit or resubmit an already-created report.
    if (this.createdReportId !== null) {
      await this.goBack();
      return;
    }

    if (this.reportStep > 1) {
      this.reportStep = (this.reportStep - 1) as 1 | 2;
      if (this.reportStep !== 2) this.destroyIncidentMap();
      this.refreshUI();
      await this.scrollToStepTop();
      return;
    }

    // Step 1 retains the previous discard confirmation.
    await this.goBack();
  }

  private async scrollToStepTop(): Promise<void> {
    // Scrolling remains available for short displays and open keyboards.
    try {
      await this.reportContent?.scrollToTop(200);
    } catch {
      // No scroll container yet (e.g., page leaving).
    }
  }

  // ==========================================
  // BACK NAVIGATION
  // ==========================================
  async goBack(): Promise<void> {
    // Prevent leaving while an operation is running.
    if (
      this.isSubmitting ||
      this.isGettingLocation ||
      this.isSelectingPhoto ||
      this.destroyed ||
      this.isBackConfirmationOpen
    ) {
      return;
    }
    if (this.createdReportId !== null) {
      await this.router.navigateByUrl('/home');
      return;
    }
    // No unsaved data: navigate directly.
    if (!this.hasUnsavedReport()) {
      await this.router.navigateByUrl('/home');
      return;
    }
    // Ask before discarding unsaved information.
    this.isBackConfirmationOpen = true;
    try {
      const alert = await this.alertController.create({
        header: 'Discard Report?',
        message:
          'You have unsaved report information. ' +
          'If you leave this page, your changes will be lost.',
        backdropDismiss: false,
        buttons: [
          {
            text: 'Keep Editing',
            role: 'cancel',
          },
          {
            text: 'Discard Report',
            role: 'destructive',
            handler: () => {
              if (!this.destroyed) {
                void this.router.navigateByUrl('/home');
              }
            },
          },
        ],
      });
      if (this.destroyed) {
        return;
      }
      await alert.present();
      await alert.onDidDismiss();
    } catch (error) {
      console.error('Back confirmation error:', error);
    } finally {
      this.isBackConfirmationOpen = false;
    }
  }
  // ==========================================
  // CHECK FOR UNSAVED REPORT INFORMATION
  // ==========================================
  private hasUnsavedReport(): boolean {
    return (
      this.reportType !== 'lost' ||
      this.itemName.trim().length > 0 ||
      this.description.trim().length > 0 ||
      this.category.trim().length > 0 ||
      this.barangay.trim().length > 0 ||
      this.specificLocation.trim().length > 0 ||
      this.dateLostFound.trim().length > 0 ||
      this.timeLostFound.trim().length > 0 ||
      this.latitude !== null ||
      this.longitude !== null ||
      this.selectedPhoto !== null
    );
  }
  // ==========================================
  // UI REFRESH HELPER
  // ==========================================
  private refreshUI(): void {
    if (this.destroyed) {
      return;
    }
    this.ngZone.run(() => {
      if (!this.destroyed) {
        this.cdr.detectChanges();
      }
    });
  }
  // ==========================================
  // CURRENT LOCATION
  // ==========================================
  async useCurrentLocation(): Promise<void> {
    if (
      this.isGettingLocation ||
      this.isSubmitting ||
      this.destroyed
    ) {
      return;
    }
    this.isGettingLocation = true;
    this.refreshUI();
    let loading:
      | Awaited<ReturnType<LoadingController['create']>>
      | undefined;
    try {
      loading = await this.loadingController.create({
        message: 'Getting your current location...',
      });
      await loading.present();
      let permission = await Geolocation.checkPermissions();
      if (
        permission.location !== 'granted' &&
        permission.coarseLocation !== 'granted'
      ) {
        permission = await Geolocation.requestPermissions();
      }
      if (
        permission.location !== 'granted' &&
        permission.coarseLocation !== 'granted'
      ) {
        throw new Error('LOCATION_PERMISSION_DENIED');
      }
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0,
      });
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        throw new Error('INVALID_COORDINATES');
      }
      if (this.destroyed) {
        return;
      }
      const matched = await this.matchBarangay(longitude, latitude);
      if (!matched) {
        throw new Error('OUTSIDE_SAN_LEONARDO');
      }
      this.ngZone.run(() => {
        this.latitude = latitude;
        this.longitude = longitude;
        this.barangay = matched;
        this.updateIncidentMarker(latitude, longitude);
        this.incidentMap?.setView([latitude, longitude], 16);
        this.refreshUI();
      });
      await this.haptics.success();
      if (!this.destroyed) {
        await this.showAlert(
          'Location Captured',
          'Your current coordinates have been added to the report. ' +
          'Make sure this is the actual place where the item was lost or found.',
        );
      }
    } catch (error: unknown) {
      if (this.destroyed) {
        return;
      }
      console.error('Get location error:', error);
      let message =
        'Unable to get your location. Check your GPS or location settings, then try again.';
      const errorMessage =
        error instanceof Error
          ? error.message
          : String(error);
      if (errorMessage === 'LOCATION_PERMISSION_DENIED') {
        message =
          'Location permission was denied. Allow location access in your device settings, then try again.';
      } else if (errorMessage === 'OUTSIDE_SAN_LEONARDO') {
        message = 'Your current phone location is outside San Leonardo. Select the actual lost/found incident location on the map instead.';
      } else if (errorMessage === 'BOUNDARY_UNAVAILABLE') {
        message = 'The San Leonardo boundary file could not be loaded. Check your internet connection or app assets and try again.';
      } else if (errorMessage === 'INVALID_COORDINATES') {
        message =
          'The device returned invalid coordinates. Please try again.';
      } else if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error
      ) {
        const locationError = error as {
          code: number;
        };
        if (locationError.code === 2) {
          message =
            'Your current location is unavailable. Turn on your device location and try again.';
        } else if (locationError.code === 3) {
          message =
            'Getting your location took too long. Please try again.';
        }
      }
      await this.haptics.warning();
      if (!this.destroyed) {
        await this.showAlert(
          'Unable to Get Location',
          message,
        );
      }
    } finally {
      if (loading) {
        try {
          await loading.dismiss();
        } catch {
          // Overlay may already be dismissed.
        }
      }
      this.isGettingLocation = false;
      this.refreshUI();
    }
  }
  // ==========================================
  // CLEAR LOCATION
  // ==========================================
  clearLocation(): void {
    if (this.isSubmitting || this.isGettingLocation) return;
    this.latitude = null;
    this.longitude = null;
    this.incidentMarker?.remove();
    this.incidentMarker = null;
    this.refreshUI();
  }

  // ==========================================
  // INTERACTIVE SAN LEONARDO INCIDENT MAP
  // ==========================================

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
    if (this.destroyed || this.reportStep !== 2) return;
    if (this.incidentMap && this.mapElement === element) {
      this.incidentMap.invalidateSize();
      return;
    }
    this.destroyIncidentMap();
    const loadId = this.mapLoadId;
    try {
      const features = await this.getBoundaryFeatures();
      if (this.destroyed || this.reportStep !== 2 ||
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
      if (this.latitude !== null && this.longitude !== null) {
        this.updateIncidentMarker(this.latitude, this.longitude);
        map.setView([this.latitude, this.longitude], 15);
      }
      setTimeout(() => {
        if (this.incidentMap === map) map.invalidateSize();
      }, 150);
    } catch (error) {
      console.error('Map initialization failed', error);
      if (!this.destroyed && this.reportStep === 2) {
        await this.showAlert('Map Unavailable',
          'San Leonardo boundary data could not be loaded. Please verify the boundary asset is installed and try again.');
      }
    }
  }

  private async selectMapPosition(lat: number, lon: number): Promise<void> {
    if (this.destroyed || this.reportStep !== 2 ||
        this.isSubmitting || this.isGettingLocation) return;
    const selectedStep = this.reportStep;
    try {
      const matched = await this.matchBarangay(lon, lat);
      if (this.destroyed || this.reportStep !== selectedStep) return;
      if (!matched) {
        await this.haptics.warning();
        await this.showAlert('Outside San Leonardo',
          'Please place the pin inside San Leonardo, Nueva Ecija. Reports outside the municipality are not accepted.');
        return;
      }
      this.ngZone.run(() => {
        this.latitude = lat;
        this.longitude = lon;
        this.barangay = matched;
        this.updateIncidentMarker(lat, lon);
        this.refreshUI();
      });
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
    if (!Number.isFinite(this.latitude) || !Number.isFinite(this.longitude)) {
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
  // Validate the incident date/time before advancing or submitting.
  // The reporting timestamp is recorded by the backend, not the client.
  private async validateIncidentDateTime(): Promise<boolean> {
    const date = this.dateLostFound.trim();
    const time = this.timeLostFound.trim();

    if (time && !date) {
      await this.showAlert('Incident Date Required',
        'Please select the date if you enter an incident time.');
      return false;
    }

    if (!date) return true; // The incident date and time remain optional.

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
      await this.showAlert('Invalid Date or Time',
        'Please select a valid incident date and time.');
      return false;
    }

    const incident = new Date(`${date}T${time || '00:00'}`);
    if (Number.isNaN(incident.getTime()) ||
        incident.getFullYear() !== Number(date.slice(0, 4)) ||
        incident.getMonth() + 1 !== Number(date.slice(5, 7)) ||
        incident.getDate() !== Number(date.slice(8, 10)) ||
        incident.getTime() > Date.now()) {
      await this.showAlert('Invalid Incident Date/Time',
        'The incident date and time must be valid and cannot be in the future.');
      return false;
    }

    return true;
  }

  // ==========================================
  // CAMERA
  // ==========================================
  async takePhoto(): Promise<void> {
    await this.capturePhoto(CameraSource.Camera);
  }
  // ==========================================
  // GALLERY
  // ==========================================
  async chooseFromGallery(): Promise<void> {
    await this.capturePhoto(CameraSource.Photos);
  }
  // ==========================================
  // CAMERA / GALLERY PROCESSING
  // ==========================================
  private async capturePhoto(
    source: CameraSource,
  ): Promise<void> {
    if (
      this.isSubmitting ||
      this.isSelectingPhoto ||
      this.destroyed
    ) {
      return;
    }
    this.photoError = '';
    this.isSelectingPhoto = true;
    this.refreshUI();
    try {
      console.log(
        '[Photo] Opening camera/gallery:',
        source,
      );
      const photo = await Camera.getPhoto({
        quality: 85,
        allowEditing: false,
        resultType: CameraResultType.Base64,
        source,
      });
      if (this.destroyed) {
        return;
      }
      if (!photo.base64String) {
        throw new Error(
          'No image data was returned.',
        );
      }
      const format = String(photo.format || 'jpeg')
        .toLowerCase()
        .replace(/^image\//i, '');
      const mimeTypes: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
      };
      const mimeType = mimeTypes[format];
      if (!mimeType) {
        throw new Error(
          `Unsupported image format: ${format}`,
        );
      }
      const previewDataUrl =
        `data:${mimeType};base64,${photo.base64String}`;
      const binary = atob(photo.base64String);
      const bytes = new Uint8Array(
        binary.length,
      );
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const imageBlob = new Blob(
        [bytes],
        {
          type: mimeType,
        },
      );
      console.log('[Photo] Format:', format);
      console.log('[Photo] MIME type:', mimeType);
      console.log(
        '[Photo] Base64 length:',
        photo.base64String.length,
      );
      console.log(
        '[Photo] Blob size:',
        imageBlob.size,
      );
      console.log(
        '[Photo] Blob type:',
        imageBlob.type,
      );
      if (imageBlob.size <= 0) {
        throw new Error(
          'The image data is empty.',
        );
      }
      if (imageBlob.size > this.maxPhotoSize) {
        this.photoError =
          'The image must not exceed 5 MB.';
        this.refreshUI();
        return;
      }
      this.ngZone.run(() => {
        if (this.destroyed) {
          return;
        }
        this.selectedPhoto = imageBlob;
        this.photoPreview = previewDataUrl;
        this.photoError = '';
        this.refreshUI();
      });
      console.log(
        '[Photo] Preview assigned:',
        Boolean(this.photoPreview),
      );
      console.log(
        '[Photo] Is Blob:',
        imageBlob instanceof Blob,
      );
      console.log(
        '[Photo] Final Blob size:',
        imageBlob.size,
      );
      console.log(
        '[Photo] Final Blob type:',
        imageBlob.type,
      );
    } catch (error: unknown) {
      if (this.destroyed) {
        return;
      }
      const message =
        error instanceof Error
          ? error.message
          : String(error);
      if (
        message.toLowerCase().includes('cancel') ||
        message.toLowerCase().includes('user cancelled')
      ) {
        return;
      }
      console.error(
        '[Photo] Camera/gallery error:',
        error,
      );
      this.photoError =
        'Unable to read the selected image. Please try again.';
      this.refreshUI();
    } finally {
      this.isSelectingPhoto = false;
      this.refreshUI();
    }
  }
  // ==========================================
  // CHOOSE IMAGE FILE
  // ==========================================
  onPhotoSelected(event: Event): void {
    const input =
      event.target as HTMLInputElement;
    const file = input.files?.[0];
    this.photoError = '';
    if (!file) {
      return;
    }
    this.processPhotoFile(file, input);
    this.refreshUI();
  }
  // ==========================================
  // IMAGE VALIDATION AND PREVIEW
  // ==========================================
  private processPhotoFile(
    file: File,
    input?: HTMLInputElement,
  ): void {
    this.photoError = '';
    const mimeType =
      typeof file.type === 'string'
        ? file.type.toLowerCase()
        : '';
    const fileSize = file.size;
    console.log(
      '[Photo] Validating MIME type:',
      mimeType,
    );
    console.log(
      '[Photo] Validating file size:',
      fileSize,
    );
    if (!this.allowedPhotoTypes.includes(mimeType)) {
      this.clearSelectedPhoto();
      this.photoError =
        'Please select a JPG, PNG, or WEBP image.';
      if (input) {
        input.value = '';
      }
      this.refreshUI();
      return;
    }
    if (fileSize <= 0) {
      this.clearSelectedPhoto();
      this.photoError =
        'The selected image is empty or could not be read.';
      if (input) {
        input.value = '';
      }
      this.refreshUI();
      return;
    }
    if (fileSize > this.maxPhotoSize) {
      this.clearSelectedPhoto();
      this.photoError =
        'The image must not exceed 5 MB.';
      if (input) {
        input.value = '';
      }
      this.refreshUI();
      return;
    }
    this.photoReader?.abort();
    this.clearSelectedPhoto();
    this.selectedPhoto = file;
    this.refreshUI();
    const reader = new FileReader();
    this.photoReader = reader;
    reader.onload = () => {
      this.ngZone.run(() => {
        if (
          this.destroyed ||
          this.photoReader !== reader
        ) {
          return;
        }
        if (typeof reader.result === 'string') {
          this.photoPreview = reader.result;
          console.log(
            '[Photo] File input preview ready.',
          );
        } else {
          this.clearSelectedPhoto();
          this.photoError =
            'Unable to preview this image. Please try another.';
          if (input) {
            input.value = '';
          }
        }
        this.refreshUI();
      });
    };
    reader.onerror = () => {
      this.ngZone.run(() => {
        if (
          this.destroyed ||
          this.photoReader !== reader
        ) {
          return;
        }
        this.clearSelectedPhoto();
        this.photoError =
          'Unable to preview this image. Please try another.';
        if (input) {
          input.value = '';
        }
        console.error(
          '[Photo] FileReader failed.',
        );
        this.refreshUI();
      });
    };
    reader.readAsDataURL(file);
  }
  // ==========================================
  // REMOVE PHOTO
  // ==========================================
  removePhoto(): void {
    this.photoReader?.abort();
    this.photoReader = undefined;
    this.clearSelectedPhoto();
    this.photoError = '';
    this.refreshUI();
  }
  // ==========================================
  // CLEAR SELECTED PHOTO
  // ==========================================
  private clearSelectedPhoto(): void {
    this.selectedPhoto = null;
    this.photoPreview = null;
  }
  // ==========================================
  // SUBMIT REPORT
  // ==========================================
  async submitReport(): Promise<void> {
    // Submission is available only on the final screen.
    if (this.reportStep !== 3) return;
    // Creating a report and uploading its photo are two separate requests.
    // Never create another report if the first request already succeeded.
    if (this.createdReportId !== null) {
      await this.showAlreadySavedAlert();
      return;
    }
    if (
      this.isSubmitting ||
      this.isGettingLocation ||
      this.isSelectingPhoto ||
      this.destroyed
    ) return;
    if (
      !this.itemName.trim() ||
      !this.description.trim() ||
      !this.category ||
      !this.barangay
    ) {
      await this.showAlert(
        'Missing Information',
        'Please complete the item name, description, category, and barangay.',
      );
      return;
    }
    if (!await this.validateIncidentDateTime()) return;
    if (!await this.validateSelectedLocation()) return;
    if (this.destroyed || this.createdReportId !== null) return;
    this.isSubmitting = true;
    this.refreshUI();
    const reportData = {
      report_type: this.reportType,
      item_name: this.itemName.trim(),
      description: this.description.trim(),
      category: this.category,
      barangay: this.barangay,
      specific_location:
        this.specificLocation.trim() || null,
      latitude: this.latitude,
      longitude: this.longitude,
      date_lost_found:
        this.dateLostFound || null,
      time_lost_found: this.timeLostFound || null,
    };
    const createRequest = this.reportsService
      .createReport(reportData)
      .subscribe({
        next: (response) => {
          if (this.destroyed) {
            return;
          }
          const reportId = response.report?.id;
          if (typeof reportId !== 'number' || !Number.isInteger(reportId) || reportId <= 0) {
            this.isSubmitting = false;
            this.refreshUI();
            void this.showAlert('Unexpected Response',
              'The server did not return a report ID. Check My Reports before submitting again.');
            return;
          }
          this.createdReportId = reportId;
          if (!this.selectedPhoto) {
            void this.finishSubmission();
            return;
          }
          const photo = this.selectedPhoto;
          if (
            !(photo instanceof Blob) ||
            photo.size <= 0
          ) {
            this.isSubmitting = false;
            this.refreshUI();
            void this.showAlreadySavedAlert(
              'Your report was created, but the selected photo could not be processed.');
            return;
          }
          const uploadRequest = this.reportsService
            .uploadReportPhoto(
              reportId,
              photo,
            )
            .subscribe({
              next: () => {
                if (!this.destroyed) {
                  void this.finishSubmission();
                }
              },
              error: async (error) => {
                if (this.destroyed) {
                  return;
                }
                await this.haptics.warning();
                console.error(
                  '[Photo] Upload error:',
                  error,
                );
                this.isSubmitting = false;
                this.refreshUI();
                await this.showAlreadySavedAlert(
                  'Your report was saved, but its photo upload failed. You can check the report in My Reports.');
              },
            });
          this.activeRequests.add(uploadRequest);
        },
        error: async (error) => {
          if (this.destroyed) {
            return;
          }
          await this.haptics.warning();
          this.isSubmitting = false;
          this.refreshUI();
          console.error(
            'Create report error:',
            error,
          );
          let message =
            'Unable to submit your report. Please try again.';
          if (error.status === 0) {
            message =
              'Cannot connect to the backend. Please check your server.';
          } else if (error.status === 401) {
            message =
              'Please log in again before submitting a report.';
      } else if (error.status === 422) {
        message = typeof error?.error?.detail === 'string'
          ? error.error.detail
          : 'Invalid incident location or form data. Please check your selected barangay and map pin.';
          }
          await this.showAlert(
            'Submission Failed',
            message,
          );
        },
      });
    this.activeRequests.add(createRequest);
  }
  // The report exists already. A second submit must never create a duplicate.
  private async showAlreadySavedAlert(
    message = 'This report has already been created. Check My Reports for its status.',
  ): Promise<void> {
    if (this.destroyed) return;
    const alert = await this.alertController.create({
      header: 'Report Already Saved',
      message,
      backdropDismiss: false,
      buttons: [{
        text: 'Go to Home',
        handler: () => {
          if (!this.destroyed) void this.router.navigateByUrl('/home');
        },
      }],
    });
    if (!this.destroyed) await alert.present();
  }
  // ==========================================
  // SUCCESSFUL SUBMISSION
  // ==========================================
  private async finishSubmission(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    await this.haptics.success();
    if (this.destroyed) {
      return;
    }
    this.isSubmitting = false;
    this.refreshUI();
    const alert = await this.alertController.create({
      header: 'Report Submitted',
      message:
        'Your item report was saved successfully.',
      buttons: [
        {
          text: 'OK',
          handler: () => {
            if (!this.destroyed) {
              void this.router.navigateByUrl('/home');
            }
          },
        },
      ],
    });
    if (!this.destroyed) {
      await alert.present();
    }
  }
  // ==========================================
  // ALERT HELPER
  // ==========================================
  private async showAlert(
    header: string,
    message: string,
  ): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const alert = await this.alertController.create({
      header,
      message,
      buttons: ['OK'],
    });
    if (!this.destroyed) {
      await alert.present();
    }
  }
  // ==========================================
  // COMPONENT CLEANUP
  // ==========================================
  ngOnDestroy(): void {
    this.destroyed = true;
    this.destroyIncidentMap();
    this.activeRequests.unsubscribe();
    if (
      this.photoReader?.readyState === FileReader.LOADING
    ) {
      this.photoReader.abort();
    }
    this.photoReader = undefined;
    this.clearSelectedPhoto();
  }
}