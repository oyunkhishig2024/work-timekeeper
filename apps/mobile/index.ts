import { registerRootComponent } from "expo";
// The geofence task has to be defined when the app starts, also when the system starts it in the background for an event.
import "./src/platform/geofence";
import App from "./src/App";

registerRootComponent(App);
