package dev.frick.demo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class FrickTask(
    val id: String,
    val title: String,
    val done: Boolean,
    val updatedAt: String,
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    FrickDemo()
                }
            }
        }
    }
}

@Composable
fun FrickDemo() {
    var tasks by remember { mutableStateOf<List<FrickTask>>(emptyList()) }
    var status by remember { mutableStateOf("Idle") }
    val scope = rememberCoroutineScope()

    suspend fun reload() {
        status = "Loading"
        try {
            tasks = fetchTasks()
            status = "Loaded ${tasks.size} tasks"
        } catch (error: Exception) {
            status = error.localizedMessage ?: "Load failed"
        }
    }

    LaunchedEffect(Unit) {
        reload()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text("Frick Demo", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text(status, style = MaterialTheme.typography.bodyMedium)
            }
            Button(onClick = { scope.launch { reload() } }) {
                Text("Reload")
            }
        }

        Spacer(Modifier.height(16.dp))

        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(tasks, key = { it.id }) { task ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = task.done, onCheckedChange = null)
                        Column(modifier = Modifier.padding(start = 8.dp)) {
                            Text(task.title, fontWeight = FontWeight.SemiBold)
                            Text(task.updatedAt, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}

suspend fun fetchTasks(): List<FrickTask> = withContext(Dispatchers.IO) {
    val url = URL("http://10.0.2.2:4099/objects?entity=Task&index=byProject&projectId=demo-project")
    val connection = (url.openConnection() as HttpURLConnection).apply {
        connectTimeout = 2_000
        readTimeout = 2_000
        requestMethod = "GET"
    }

    connection.inputStream.bufferedReader().use { reader ->
        val json = JSONObject(reader.readText())
        val rows = json.getJSONArray("data")
        buildList {
            for (index in 0 until rows.length()) {
                val item = rows.getJSONObject(index)
                add(
                    FrickTask(
                        id = item.getString("id"),
                        title = item.getString("title"),
                        done = item.getBoolean("done"),
                        updatedAt = item.getString("updatedAt"),
                    ),
                )
            }
        }
    }
}
