import SwiftUI

/// Available before sign-in without a server connection or account state.
struct PrivacyPolicySheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PrivacyPolicyContent()
                .navigationTitle(String(localized: "privacyPolicy.title"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { SheetCloseToolbar { dismiss() } }
        }
        .appSheetPresentation(.expanded)
    }
}

/// Settings pushes the same content inside its existing navigation stack.
struct PrivacyPolicyContent: View {
    var body: some View {
        List {
            Section {
                paragraph("privacyPolicy.introduction")
            } header: {
                Text(verbatim: "Agents Anywhere")
            } footer: {
                Text(String(localized: "privacyPolicy.updated"))
            }

            Section(String(localized: "privacyPolicy.server.title")) {
                paragraph("privacyPolicy.server.body")
            }

            Section(String(localized: "privacyPolicy.agents.title")) {
                paragraph("privacyPolicy.agents.body")
                paragraph("privacyPolicy.externalContent.body")
            }

            Section(String(localized: "privacyPolicy.localStorage.title")) {
                paragraph("privacyPolicy.localStorage.body")
            }

            Section(String(localized: "privacyPolicy.permissions.title")) {
                paragraph("privacyPolicy.permissions.body")
            }

            Section(String(localized: "privacyPolicy.retention.title")) {
                paragraph("privacyPolicy.retention.body")
            }

            Section(String(localized: "privacyPolicy.contact.title")) {
                paragraph("privacyPolicy.contact.body")
                Link(destination: URL(string: "https://github.com/anywhere-labs/Agents-Anywhere")!) {
                    Label(String(localized: "privacyPolicy.projectSupport"), appSymbol: "arrow.up.right")
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func paragraph(_ text: LocalizedStringResource) -> some View {
        Text(text)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

#Preview {
    PrivacyPolicySheet()
}
