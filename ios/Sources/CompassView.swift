import SwiftUI

struct CompassView: View {
    @StateObject private var headingManager = HeadingManager()

    private let segments: Int = 64
    private let innerRadius: CGFloat = 160
    private let padding: CGFloat = 110

    // No simulator auto-rotation in the reverted state

    var body: some View {
        ZStack {
            Color.white.ignoresSafeArea()

            GeometryReader { geo in
                let width: CGFloat = geo.size.width
                let height: CGFloat = geo.size.height
                let size: CGFloat = min(width, height)
                let heading: Double = headingManager.headingDegrees

                ZStack {
                    CompassDialCanvas(
                        size: size,
                        padding: padding,
                        innerRadius: innerRadius,
                        headingDegrees: heading,
                        segments: segments
                    )
                    .frame(width: size, height: size)

                    TriangleMarker()
                        .fill(Color(.sRGB, red: 0.07, green: 0.09, blue: 0.15, opacity: 1.0))
                        .frame(width: 24, height: 24)
                        .offset(y: -(((size / 2) - padding) + 17))

                    VStack(spacing: 4) {
                        Text(String(format: "%.0f°", heading))
                            .font(.system(size: 44, weight: .bold))
                            .foregroundColor(Color(.sRGB, red: 0.06, green: 0.09, blue: 0.16, opacity: 1.0))
                        Text(bearingName(for: heading))
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(Color(.sRGB, red: 0.25, green: 0.30, blue: 0.40, opacity: 1.0))
                    }
                }
                .frame(width: size, height: size)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            CompassTopBar(
                isActive: isActive,
                headingDegrees: headingManager.headingDegrees,
                onEnable: enable
            )
            .frame(maxHeight: .infinity, alignment: .top)
            .padding(.top, 12)
        }
        .onAppear { updateAuth() }
    }

    private var isActive: Bool {
        switch headingManager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            return true
        default:
            return false
        }
    }

    private func enable() {
        headingManager.requestAuthorization()
        headingManager.start()
    }

    private func updateAuth() {
        switch headingManager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            headingManager.start()
        default:
            break
        }
    }

    private func bearingName(for degrees: Double) -> String {
        // 16-wind compass rose
        let names = [
            "N", "NNE", "NE", "ENE",
            "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW",
            "W", "WNW", "NW", "NNW"
        ]
        let step = 360.0 / Double(names.count) // 22.5
        var d = degrees
        if d < 0 { d += 360 }
        let index = Int((d + step/2).truncatingRemainder(dividingBy: 360) / step)
        return names[index]
    }
}

private struct CompassTopBar: View {
    let isActive: Bool
    let headingDegrees: Double
    let onEnable: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text("Compass")
                .font(.system(size: 14))
                .foregroundColor(Color(.sRGB, red: 0.2, green: 0.25, blue: 0.33, opacity: 1))

            if !isActive {
                Button(action: onEnable) {
                    Text("Enable compass")
                        .font(.system(size: 12, weight: .semibold))
                        .padding(.vertical, 6)
                        .padding(.horizontal, 10)
                        .background(Color(.sRGB, red: 0.06, green: 0.09, blue: 0.16, opacity: 1.0))
                        .foregroundColor(.white)
                        .cornerRadius(9999)
                }
            }

            Text(String(format: "%.2f°", headingDegrees))
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(Color(.sRGB, red: 0.06, green: 0.09, blue: 0.16, opacity: 1.0))
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(Color.white.opacity(0.85))
        .overlay(
            RoundedRectangle(cornerRadius: 9999)
                .stroke(Color(.sRGB, red: 0.89, green: 0.91, blue: 0.94, opacity: 1), lineWidth: 1)
        )
        .cornerRadius(9999)
        .shadow(color: Color.black.opacity(0.08), radius: 2, x: 0, y: 1)
    }
}

private struct CompassDialCanvas: View {
    let size: CGFloat
    let padding: CGFloat
    let innerRadius: CGFloat
    let headingDegrees: Double
    let segments: Int

    var body: some View {
        let halfSize: CGFloat = size / 2
        let outerR: Double = Double(halfSize - padding)
        let innerR: Double = Double(innerRadius)
        let slice: Double = 2 * .pi / Double(segments)
        let startAngle: Double = -Double.pi / 2 + headingDegrees * .pi / 180

        let segmentLines: AnyView = AnyView(DialSegmentLines(segments: segments, startAngle: startAngle, slice: slice, innerR: innerR, outerR: outerR))
        let ticksLabels: AnyView = AnyView(DialTicksLabels(segments: segments, startAngle: startAngle, slice: slice, outerR: outerR, headingDegrees: headingDegrees))
        let rings: AnyView = AnyView(DialRings(innerR: innerR, outerR: outerR))
        let bigLabels: AnyView = AnyView(DialBigLabels(segments: segments, startAngle: startAngle, slice: slice, innerR: innerR, outerR: outerR))
        let cardinals: AnyView = AnyView(DialCardinals(outerR: outerR, headingDegrees: headingDegrees))

        ZStack {
            Rectangle().fill(Color.white)
            segmentLines
            ticksLabels
            rings
            bigLabels
            cardinals
        }
    }
}

private struct DialSegmentLines: View {
    let segments: Int
    let startAngle: Double
    let slice: Double
    let innerR: Double
    let outerR: Double

    var body: some View {
        Canvas { context, canvasSize in
            let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
            let minor = Color(.sRGB, red: 0.06, green: 0.09, blue: 0.16, opacity: 0.15)
            let major = Color(.sRGB, red: 0.06, green: 0.09, blue: 0.16, opacity: 0.9)
            for i in 0..<segments {
                let a0: Double = startAngle + Double(i) * slice
                var p = Path()
                p.move(to: CGPoint(x: center.x + innerR * cos(a0), y: center.y + innerR * sin(a0)))
                p.addLine(to: CGPoint(x: center.x + (outerR - 2) * cos(a0), y: center.y + (outerR - 2) * sin(a0)))
                context.stroke(p, with: .color(minor), lineWidth: 1)
                if i % 8 == 0 {
                    var p2 = Path()
                    p2.move(to: CGPoint(x: center.x + innerR * cos(a0), y: center.y + innerR * sin(a0)))
                    p2.addLine(to: CGPoint(x: center.x + outerR * cos(a0), y: center.y + outerR * sin(a0)))
                    context.stroke(p2, with: .color(major), lineWidth: 4)
                }
            }
        }
    }
}

private struct DialTicksLabels: View {
    let segments: Int
    let startAngle: Double
    let slice: Double
    let outerR: Double
    let headingDegrees: Double

    var body: some View {
        Canvas { context, canvasSize in
            let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
            let textColor = Color(.sRGB, red: 0.06, green: 0.09, blue: 0.16, opacity: 1.0)
            for i in 0..<segments {
                let deg: Double = (Double(i) * (360.0 / Double(segments))).truncatingRemainder(dividingBy: 360)
                let angle: Double = (deg - 90) * (.pi / 180) + headingDegrees * .pi / 180

                // Ticks: thin for minor, thick for every 8th, medium for every 2nd
                let isMajor = i % 8 == 0
                let isMedium = i % 2 == 0
                let tickIn: Double = outerR + (isMajor ? 0 : isMedium ? 4 : 6)
                let tickOut: Double = outerR + (isMajor ? 16 : isMedium ? 12 : 10)
                var t = Path()
                t.move(to: CGPoint(x: center.x + tickIn * cos(angle), y: center.y + tickIn * sin(angle)))
                t.addLine(to: CGPoint(x: center.x + tickOut * cos(angle), y: center.y + tickOut * sin(angle)))
                let alpha: Double = isMajor ? 0.9 : isMedium ? 0.6 : 0.33
                context.stroke(t, with: .color(Color(.sRGB, red: 0.06, green: 0.09, blue: 0.16, opacity: alpha)), lineWidth: isMajor ? 2 : 1)

                // Labels only every 8th segment, large and outside
                if isMajor {
                    let rText: Double = outerR + 28
                    let lx: Double = rText * cos(angle)
                    let ly: Double = rText * sin(angle)
                    let label = Text(String(format: "%.0f°", deg))
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(textColor)
                    context.draw(label, at: CGPoint(x: center.x + lx, y: center.y + ly), anchor: .center)
                }
            }
        }
    }
}

private struct DialRings: View {
    let innerR: Double
    let outerR: Double

    var body: some View {
        Canvas { context, canvasSize in
            let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
            let stroke = Color(.sRGB, red: 0.06, green: 0.09, blue: 0.16, opacity: 1.0)
            // Outer ring
            var outer = Path()
            outer.addArc(center: center, radius: outerR, startAngle: .zero, endAngle: .degrees(360), clockwise: false)
            context.stroke(outer, with: .color(stroke), lineWidth: 3)
            var inner = Path()
            inner.addArc(center: center, radius: innerR, startAngle: .zero, endAngle: .degrees(360), clockwise: false)
            context.stroke(inner, with: .color(stroke), lineWidth: 3)
            // Shadow ring for separation
            var shadow = Path()
            shadow.addArc(center: center, radius: outerR + 2, startAngle: .zero, endAngle: .degrees(360), clockwise: false)
            context.stroke(shadow, with: .color(Color.black.opacity(0.06)), lineWidth: 2)
        }
    }
}

private struct DialBigLabels: View {
    let segments: Int
    let startAngle: Double
    let slice: Double
    let innerR: Double
    let outerR: Double

    var body: some View {
        Canvas { context, canvasSize in
            let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
            let textColor = Color(.sRGB, red: 0.06, green: 0.09, blue: 0.16, opacity: 1.0)
            let bigLabels: [String] = ["NW","N","NE","E","SE","S","SW","W"]
            let bigSlice: Double = slice * Double(segments) / 8.0
            for b in 0..<8 {
                let a0: Double = startAngle + Double(b) * bigSlice
                let amid: Double = a0 + bigSlice / 2
                let r: Double = (outerR + innerR) / 2
                let x: Double = r * cos(amid)
                let y: Double = r * sin(amid)
                let text = Text(bigLabels[b])
                    .font(.system(size: 28, weight: .bold))
                    .foregroundColor(textColor)
                context.draw(text, at: CGPoint(x: center.x + x, y: center.y + y), anchor: .center)
            }
        }
    }
}

private struct DialCardinals: View {
    let outerR: Double
    let headingDegrees: Double

    var body: some View {
        Canvas { context, canvasSize in
            let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
            let textColor = Color(.sRGB, red: 0.06, green: 0.09, blue: 0.16, opacity: 1.0)
            let cardinals: [(String, Double)] = [("N",0),("E",90),("S",180),("W",270)]
            for (t, d) in cardinals {
                let a: Double = (d - 90) * (.pi / 180) + headingDegrees * .pi / 180
                let r: Double = outerR + 64
                let x: Double = r * cos(a)
                let y: Double = r * sin(a)
                let text = Text(t)
                    .font(.system(size: 34, weight: .black))
                    .foregroundColor(textColor)
                context.draw(text, at: CGPoint(x: center.x + x, y: center.y + y), anchor: .center)
            }
        }
    }
}
private struct TriangleMarker: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let top = CGPoint(x: rect.midX, y: rect.minY)
        let bl = CGPoint(x: rect.minX, y: rect.maxY)
        let br = CGPoint(x: rect.maxX, y: rect.maxY)
        p.move(to: top)
        p.addLine(to: bl)
        p.addLine(to: br)
        p.closeSubpath()
        return p
    }
}
