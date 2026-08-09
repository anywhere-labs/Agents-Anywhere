import PhotosUI
import SwiftUI

struct AvatarSettingsView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var selectedItem: PhotosPickerItem?
    @State private var selectedImage: UIImage?
    @State private var zoom: CGFloat = 1
    @State private var offset = CGSize.zero
    @State private var localError: String?

    var body: some View {
        Form {
            Section {
                AvatarEditorPreview(
                    userId: appState.me?.userId ?? "?",
                    currentSource: appState.accountAvatarSource,
                    selectedImage: selectedImage,
                    zoom: $zoom,
                    offset: $offset
                )
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }

            Section {
                PhotosPicker(selection: $selectedItem, matching: .images) {
                    Label("Choose photo", systemImage: "photo.on.rectangle")
                }

                if selectedImage != nil {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Zoom")
                            .font(.subheadline)
                        Slider(value: $zoom, in: 1 ... 3)
                    }

                    Button(action: uploadAvatar) {
                        AccountSettingsActionLabel(
                            title: "Save profile photo",
                            isWorking: appState.isAccountWorking
                        )
                    }
                    .disabled(appState.isAccountWorking)
                }
            }

            if appState.me?.avatar != nil {
                Section {
                    Button("Remove profile photo", role: .destructive, action: removeAvatar)
                        .disabled(appState.isAccountWorking)
                }
            }
        }
        .navigationTitle("Profile photo")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: selectedItem) { _, nextItem in
            guard let nextItem else { return }
            Task { await loadImage(nextItem) }
        }
        .onChange(of: zoom) { _, nextZoom in
            guard let selectedImage else { return }
            offset = AccountAvatarProcessor.clampedOffset(
                image: selectedImage,
                zoom: nextZoom,
                candidate: offset
            )
        }
        .alert("Could not use photo", isPresented: localErrorBinding) {
            Button("OK", role: .cancel) {
                localError = nil
            }
        } message: {
            Text(localError ?? "")
        }
    }

    private var localErrorBinding: Binding<Bool> {
        Binding(
            get: { localError != nil },
            set: { isPresented in
                if !isPresented { localError = nil }
            }
        )
    }

    private func loadImage(_ item: PhotosPickerItem) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw AccountAvatarProcessingError.invalidImage
            }
            selectedImage = try AccountAvatarProcessor.image(from: data)
            zoom = 1
            offset = .zero
            localError = nil
        } catch {
            selectedImage = nil
            localError = error.localizedDescription
        }
    }

    private func uploadAvatar() {
        guard let selectedImage else { return }
        do {
            let dataURL = try AccountAvatarProcessor.dataURL(
                image: selectedImage,
                zoom: zoom,
                offset: offset
            )
            Task {
                if await appState.updateAccountAvatar(dataURL: dataURL) {
                    dismiss()
                }
            }
        } catch {
            localError = error.localizedDescription
        }
    }

    private func removeAvatar() {
        Task {
            if await appState.clearAccountAvatar() {
                selectedImage = nil
                selectedItem = nil
                zoom = 1
                offset = .zero
            }
        }
    }
}

private struct AvatarEditorPreview: View {
    let userId: String
    let currentSource: AccountAvatarImageSource?
    let selectedImage: UIImage?
    @Binding var zoom: CGFloat
    @Binding var offset: CGSize

    @GestureState private var dragTranslation = CGSize.zero

    var body: some View {
        if let selectedImage {
            Image(uiImage: selectedImage)
                .resizable()
                .scaledToFill()
                .frame(
                    width: AccountAvatarProcessor.outputSize,
                    height: AccountAvatarProcessor.outputSize
                )
                .scaleEffect(zoom)
                .offset(displayOffset(image: selectedImage))
                .frame(
                    width: AccountAvatarProcessor.outputSize,
                    height: AccountAvatarProcessor.outputSize
                )
                .clipShape(Circle())
                .overlay {
                    Circle()
                        .strokeBorder(.white.opacity(0.9), lineWidth: 2)
                }
                .contentShape(Circle())
                .gesture(dragGesture(image: selectedImage))
        } else {
            AccountAvatarView(
                userId: userId,
                source: currentSource,
                size: AccountAvatarProcessor.outputSize
            )
        }
    }

    private func displayOffset(image: UIImage) -> CGSize {
        AccountAvatarProcessor.clampedOffset(
            image: image,
            zoom: zoom,
            candidate: CGSize(
                width: offset.width + dragTranslation.width,
                height: offset.height + dragTranslation.height
            )
        )
    }

    private func dragGesture(image: UIImage) -> some Gesture {
        DragGesture()
            .updating($dragTranslation) { value, state, _ in
                state = value.translation
            }
            .onEnded { value in
                offset = AccountAvatarProcessor.clampedOffset(
                    image: image,
                    zoom: zoom,
                    candidate: CGSize(
                        width: offset.width + value.translation.width,
                        height: offset.height + value.translation.height
                    )
                )
            }
    }
}

private struct AccountSettingsActionLabel: View {
    let title: LocalizedStringResource
    let isWorking: Bool

    var body: some View {
        HStack {
            Spacer()
            if isWorking {
                ProgressView()
                    .controlSize(.small)
            }
            Text(title)
            Spacer()
        }
    }
}
