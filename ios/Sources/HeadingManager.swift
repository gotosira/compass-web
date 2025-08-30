import Foundation
import CoreLocation
import Combine

final class HeadingManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var heading: CLHeading?
    @Published var authorizationStatus: CLAuthorizationStatus

    private let locationManager: CLLocationManager

    override init() {
        self.locationManager = CLLocationManager()
        self.authorizationStatus = Self.currentAuthorizationStatus(for: CLLocationManager())
        super.init()

        self.locationManager.delegate = self
        self.locationManager.headingFilter = kCLHeadingFilterNone
        self.locationManager.distanceFilter = kCLDistanceFilterNone
        self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
    }

    static func currentAuthorizationStatus(for manager: CLLocationManager) -> CLAuthorizationStatus {
        if #available(iOS 14.0, *) {
            return manager.authorizationStatus
        } else {
            return CLLocationManager.authorizationStatus()
        }
    }

    func requestAuthorization() {
        self.locationManager.requestWhenInUseAuthorization()
    }

    func start() {
        if CLLocationManager.headingAvailable() {
            self.locationManager.startUpdatingHeading()
        }
    }

    func stop() {
        self.locationManager.stopUpdatingHeading()
    }

    func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {
        DispatchQueue.main.async {
            self.authorizationStatus = status
        }
        if status == .authorizedAlways || status == .authorizedWhenInUse {
            start()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        DispatchQueue.main.async {
            self.heading = newHeading
        }
    }

    func locationManagerShouldDisplayHeadingCalibration(_ manager: CLLocationManager) -> Bool {
        return true
    }

    var headingDegrees: Double {
        guard let h = heading else { return 0 }
        let trueHeading = h.trueHeading
        let magneticHeading = h.magneticHeading
        let deg = trueHeading >= 0 ? trueHeading : magneticHeading
        return normalizeDegrees(deg)
    }

    private func normalizeDegrees(_ deg: Double) -> Double {
        var d = deg.truncatingRemainder(dividingBy: 360)
        if d < 0 { d += 360 }
        return d
    }
}
