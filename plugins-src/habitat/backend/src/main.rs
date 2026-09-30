#[tokio::main(flavor = "multi_thread", worker_threads = 3)]
async fn main() {
    notemd_habitat::rpc::serve(tokio::io::stdin(), tokio::io::stdout()).await;
}
