import SwiftUI

struct FrickTask: Identifiable, Codable {
    let id: String
    let projectId: String
    let tenantId: String
    let title: String
    let done: Bool
    let updatedAt: String
}

struct ObjectsResponse: Codable {
    let entity: String
    let index: String
    let data: [FrickTask]
}

@MainActor
final class TaskModel: ObservableObject {
    @Published var tasks: [FrickTask] = []
    @Published var status = "Idle"

    func load() async {
        status = "Loading"
        do {
            let url = URL(string: "http://127.0.0.1:4099/objects?entity=Task&index=byProject&projectId=demo-project")!
            let (data, _) = try await URLSession.shared.data(from: url)
            let decoded = try JSONDecoder().decode(ObjectsResponse.self, from: data)
            tasks = decoded.data
            status = "Loaded \(decoded.data.count) tasks"
        } catch {
            status = error.localizedDescription
        }
    }
}

struct ContentView: View {
    @StateObject private var model = TaskModel()

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(model.tasks) { task in
                        HStack(spacing: 12) {
                            Image(systemName: task.done ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(task.done ? .green : .secondary)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(task.title)
                                    .font(.headline)
                                Text(task.updatedAt)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                } header: {
                    Text("Server data")
                }
            }
            .navigationTitle("Frick Demo")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Reload")
                }
            }
            .safeAreaInset(edge: .bottom) {
                Text(model.status)
                    .font(.footnote.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(12)
                    .background(.thinMaterial)
            }
            .task {
                await model.load()
            }
        }
    }
}
