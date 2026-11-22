import AAClientCore
import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("last_control_url") private var controlURL = "https://"
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    enum Field { case url, email, password }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 10) {
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                            .font(.system(size: 44, weight: .light))
                            .foregroundStyle(.tint)
                        Text("Agents Anywhere")
                            .font(.title2.weight(.semibold))
                        Text("登录你的控制面，查看和操作各台工作设备上的 Agent。")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }

                Section("控制面") {
                    TextField("地址，例如 https://aa.example.com", text: $controlURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .url)
                        .submitLabel(.next)
                        .onSubmit { focus = .email }
                }

                Section("账号") {
                    TextField("邮箱", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .email)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                    SecureField("密码", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit(signIn)
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button(action: signIn) {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text("登录").fontWeight(.semibold) }
                            Spacer()
                        }
                    }
                    .disabled(busy || email.isEmpty || password.isEmpty || ControlHTTPClient.normalize(controlURL) == nil)
                }
            }
            .navigationTitle("登录")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func signIn() {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await model.signIn(controlURL: controlURL, email: email.trimmingCharacters(in: .whitespaces), password: password)
            } catch {
                self.error = AppModel.describe(error)
            }
        }
    }
}
