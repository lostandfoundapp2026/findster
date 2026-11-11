// Save as: src/app/tabs/tabs.page.ts
// FINDSTER - MAIN FOUR-TAB NAVIGATION
// Ionic manages active tab selection and routes through ion-tabs.

import { Component } from '@angular/core';
import {
  IonTabs,
  IonTabBar,
  IonTabButton,
  IonIcon,
  IonLabel,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  homeOutline,
  home,
  documentTextOutline,
  chatbubbleEllipsesOutline,
  chatbubbleEllipses,
  personCircleOutline,
  personCircle,
} from 'ionicons/icons';

@Component({
  selector: 'app-tabs',
  templateUrl: './tabs.page.html',
  styleUrls: ['./tabs.page.scss'],
  standalone: true,
  imports: [
    IonTabs,
    IonTabBar,
    IonTabButton,
    IonIcon,
    IonLabel,
  ],
})
export class TabsPage {
  constructor() {
    addIcons({
      homeOutline,
      home,
      documentTextOutline,
      chatbubbleEllipsesOutline,
      chatbubbleEllipses,
      personCircleOutline,
      personCircle,
    });
  }
}